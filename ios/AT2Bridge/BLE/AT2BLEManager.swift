//
//  AT2BLEManager.swift
//  AT2Bridge
//
//  CoreBluetooth transport for the AT2 radio -- the native counterpart to
//  `app/transport/ble_transport.py` (Python/bleak) and the browser's
//  `app/static/ble-client.js` (Web Bluetooth), needed here because iOS
//  Safari/WebKit has no Web Bluetooth support at all (see README.md,
//  "Known limitations").
//
//  GATT UUIDs reverse-engineered (btsnoop capture) in the reference
//  Android app (`BleConstants.kt`, Apache-2.0):
//
//      SERVICE_UUID = 0000AE60-0000-1000-8000-00805F9B34FB
//      TX_CHAR_UUID = 0000AE10-0000-1000-8000-00805F9B34FB  (write)
//      RX_CHAR_UUID = 0000AE05-0000-1000-8000-00805F9B34FB  (notify)
//
//  See /THIRD_PARTY_NOTICES.md for full attribution.
//

import Foundation
import Combine
import CoreBluetooth

struct DiscoveredDevice: Identifiable, Equatable {
    let id: UUID
    let name: String
    let rssi: Int
    let peripheral: CBPeripheral

    static func == (lhs: DiscoveredDevice, rhs: DiscoveredDevice) -> Bool {
        lhs.id == rhs.id
    }
}

enum BLEConnectionState: Equatable {
    case poweredOff
    case unauthorized
    case idle
    case scanning
    case connecting(String)
    case connected(String)
    case failed(String)
}

@MainActor
final class AT2BLEManager: NSObject, ObservableObject {
    static let serviceUUID = CBUUID(string: "0000AE60-0000-1000-8000-00805F9B34FB")
    static let txCharUUID = CBUUID(string: "0000AE10-0000-1000-8000-00805F9B34FB")
    static let rxCharUUID = CBUUID(string: "0000AE05-0000-1000-8000-00805F9B34FB")

    @Published private(set) var state: BLEConnectionState = .idle
    @Published private(set) var discovered: [DiscoveredDevice] = []
    @Published private(set) var log: [String] = []
    @Published private(set) var lastChannel: ChannelConfig?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var txChar: CBCharacteristic?
    private var rxChar: CBCharacteristic?

    /// Rolling buffer of bytes received via notifications, fed to both
    /// frame decoders (legacy + CPS dialects) until one matches.
    private var rxBuffer: [UInt8] = []

    private var pendingReadContinuation: CheckedContinuation<ChannelConfig, Error>?
    private var pendingWriteContinuation: CheckedContinuation<Void, Error>?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    // MARK: - Scanning

    func startScan() {
        discovered = []
        guard central.state == .poweredOn else {
            appendLog("Impossible de scanner: Bluetooth n'est pas activé")
            return
        }
        state = .scanning
        central.scanForPeripherals(withServices: [Self.serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        appendLog("Scan démarré (service \(Self.serviceUUID.uuidString))")
    }

    func stopScan() {
        central.stopScan()
        if case .scanning = state { state = .idle }
    }

    // MARK: - Connection

    func connect(_ device: DiscoveredDevice) {
        stopScan()
        state = .connecting(device.name)
        peripheral = device.peripheral
        peripheral?.delegate = self
        appendLog("Connexion à \(device.name)…")
        central.connect(device.peripheral, options: nil)
    }

    func disconnect() {
        if let peripheral {
            central.cancelPeripheralConnection(peripheral)
        }
        cleanupAfterDisconnect()
    }

    private func cleanupAfterDisconnect() {
        peripheral = nil
        txChar = nil
        rxChar = nil
        rxBuffer.removeAll()
        state = .idle
        failPendingContinuations(AT2BLEError.notConnected)
    }

    // MARK: - Channel read/write (CPS dialect)

    func readChannel(_ channel: Int) async throws -> ChannelConfig {
        guard txChar != nil, peripheral != nil else { throw AT2BLEError.notConnected }
        let payload = try AT2Channel.buildChannelReadRequest(channel: channel)
        let frame = try AT2Frame.encodeCPSFrame(payload)
        return try await withCheckedThrowingContinuation { continuation in
            self.pendingReadContinuation = continuation
            self.sendRawFrame(frame, label: "READ ch\(channel)")
        }
    }

    func writeChannel(_ config: ChannelConfig) async throws {
        guard txChar != nil, peripheral != nil else { throw AT2BLEError.notConnected }
        let payload = try AT2Channel.buildChannelWriteRequest(config)
        let frame = try AT2Frame.encodeCPSFrame(payload)
        return try await withCheckedThrowingContinuation { continuation in
            self.pendingWriteContinuation = continuation
            self.sendRawFrame(frame, label: "WRITE ch\(config.channel)")
            // The radio's write acknowledgment shape hasn't been fully
            // pinned down yet (see README "Implemented, pending hardware
            // confirmation") -- resolve optimistically shortly after
            // sending rather than waiting indefinitely for a reply that
            // may not distinguish itself from other traffic.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard let self, let cont = self.pendingWriteContinuation else { return }
                self.pendingWriteContinuation = nil
                cont.resume()
            }
        }
    }

    /// Quick channel select (legacy dialect) -- makes the radio switch to
    /// the given channel immediately, without touching its stored config.
    func selectChannel(_ channel: Int) throws {
        guard txChar != nil, peripheral != nil else { throw AT2BLEError.notConnected }
        let payload = try AT2Commands.selectChannel(channel)
        let frame = try AT2Frame.encodeFrame(payload)
        sendRawFrame(frame, label: "SELECT ch\(channel)")
    }

    private func sendRawFrame(_ frame: [UInt8], label: String) {
        guard let peripheral, let txChar else { return }
        appendLog("TX [\(label)] \(hex(frame))")
        let data = Data(frame)
        peripheral.writeValue(data, for: txChar, type: .withResponse)
    }

    // MARK: - Incoming data

    private func handleNotification(_ data: Data) {
        rxBuffer += [UInt8](data)
        appendLog("RX brut: \(hex([UInt8](data)))")

        // Try the CPS dialect first (channel read/write replies), then the
        // legacy dialect, draining as many complete frames as are buffered.
        var madeProgress = true
        while madeProgress {
            madeProgress = false

            let (cpsPayload, cpsConsumed) = AT2Frame.tryDecodeCPSFrame(rxBuffer)
            if let cpsPayload {
                rxBuffer.removeFirst(cpsConsumed)
                madeProgress = true
                handleCPSPayload(cpsPayload)
                continue
            } else if cpsConsumed > 0 {
                rxBuffer.removeFirst(cpsConsumed)
                madeProgress = true
                continue
            }

            let (legacyPayload, legacyConsumed) = AT2Frame.tryDecodeFrame(rxBuffer)
            if let legacyPayload {
                rxBuffer.removeFirst(legacyConsumed)
                madeProgress = true
                handleLegacyPayload(legacyPayload)
                continue
            } else if legacyConsumed > 0 {
                rxBuffer.removeFirst(legacyConsumed)
                madeProgress = true
                continue
            }
        }

        // Avoid unbounded growth if we never find a valid header.
        if rxBuffer.count > 4096 {
            appendLog("Tampon RX trop grand sans trame valide, purge")
            rxBuffer.removeAll()
        }
    }

    private func handleCPSPayload(_ payload: [UInt8]) {
        guard let packet = AT2Frame.decodeCPSPacket(payload) else { return }
        appendLog("RX CPS opcode=\(hexByte(packet.opcode)) group=\(hexByte(packet.group)) param=\(hexByte(packet.param)) body=\(hex(packet.body))")

        // 0x91 = 0x11 (read) | 0x80 (ack/reply bit)
        if packet.opcode == 0x91, packet.group == 0x02, packet.param == 0x02 {
            do {
                let config = try AT2Channel.decodeChannelReadResponse(packet.body)
                lastChannel = config
                pendingReadContinuation?.resume(returning: config)
                pendingReadContinuation = nil
            } catch {
                pendingReadContinuation?.resume(throwing: error)
                pendingReadContinuation = nil
            }
        }
        // 0x92 = 0x12 (write) | 0x80: treat any reply as a write acknowledgment.
        if packet.opcode == 0x92 {
            pendingWriteContinuation?.resume()
            pendingWriteContinuation = nil
        }
    }

    private func handleLegacyPayload(_ payload: [UInt8]) {
        guard let packet = AT2Frame.decodePacket(payload) else { return }
        appendLog("RX legacy family=\(hexByte(packet.family)) command=\(hexByte(packet.command)) body=\(hex(packet.body))")
    }

    private func failPendingContinuations(_ error: Error) {
        pendingReadContinuation?.resume(throwing: error)
        pendingReadContinuation = nil
        pendingWriteContinuation?.resume(throwing: error)
        pendingWriteContinuation = nil
    }

    // MARK: - Logging helpers

    private func appendLog(_ line: String) {
        log.append(line)
        if log.count > 500 {
            log.removeFirst(log.count - 500)
        }
    }

    private func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func hexByte(_ b: UInt8) -> String {
        String(format: "0x%02x", b)
    }
}

enum AT2BLEError: Error, LocalizedError {
    case notConnected
    case missingCharacteristics

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Non connecté au talkie-walkie"
        case .missingCharacteristics: return "Caractéristiques GATT introuvables"
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension AT2BLEManager: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            switch central.state {
            case .poweredOn:
                if self.state == .poweredOff { self.state = .idle }
            case .poweredOff:
                self.state = .poweredOff
            case .unauthorized:
                self.state = .unauthorized
            default:
                break
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = peripheral.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? "(inconnu)"
        let id = peripheral.identifier
        let rssiValue = RSSI.intValue
        Task { @MainActor in
            if let index = self.discovered.firstIndex(where: { $0.id == id }) {
                self.discovered[index] = DiscoveredDevice(id: id, name: name, rssi: rssiValue, peripheral: peripheral)
            } else {
                self.discovered.append(DiscoveredDevice(id: id, name: name, rssi: rssiValue, peripheral: peripheral))
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { @MainActor in
            self.appendLog("Connecté, découverte des services…")
            peripheral.discoverServices([Self.serviceUUID])
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        Task { @MainActor in
            self.state = .failed(error?.localizedDescription ?? "échec de connexion")
            self.appendLog("Échec de connexion: \(error?.localizedDescription ?? "inconnu")")
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        Task { @MainActor in
            self.appendLog("Déconnecté" + (error.map { ": \($0.localizedDescription)" } ?? ""))
            self.cleanupAfterDisconnect()
        }
    }
}

// MARK: - CBPeripheralDelegate

extension AT2BLEManager: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let services = peripheral.services else { return }
        for service in services where service.uuid == Self.serviceUUID {
            peripheral.discoverCharacteristics([Self.txCharUUID, Self.rxCharUUID], for: service)
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil, let characteristics = service.characteristics else { return }
        Task { @MainActor in
            for characteristic in characteristics {
                if characteristic.uuid == Self.txCharUUID {
                    self.txChar = characteristic
                }
                if characteristic.uuid == Self.rxCharUUID {
                    self.rxChar = characteristic
                    peripheral.setNotifyValue(true, for: characteristic)
                }
            }
            if self.txChar != nil {
                let name = peripheral.name ?? "AT2"
                self.state = .connected(name)
                self.appendLog("Prêt (TX/RX découverts)")
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.uuid == Self.rxCharUUID, let data = characteristic.value else { return }
        Task { @MainActor in
            self.handleNotification(data)
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            Task { @MainActor in
                self.appendLog("Erreur d'écriture: \(error.localizedDescription)")
            }
        }
    }
}
