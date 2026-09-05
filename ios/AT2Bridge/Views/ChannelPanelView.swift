//
//  ChannelPanelView.swift
//  AT2Bridge
//
//  Single-channel read/write UI (BLE-minimal scope) -- one channel at a
//  time via the CPS dialect, same as the web interface's channel table
//  (see README.md "Confirmed working on real hardware"). Plus a quick
//  channel-select action (legacy dialect) to switch the radio's active
//  channel without touching its stored configuration.
//

import SwiftUI

struct ChannelPanelView: View {
    @ObservedObject var ble: AT2BLEManager

    @State private var channelNumber: Int = 1
    @State private var config: ChannelConfig = .empty(channel: 1)
    @State private var isBusy = false
    @State private var errorMessage: String?

    private let toneOptions = AT2Channel.toneOptions()

    var body: some View {
        Form {
            Section("Canal") {
                Stepper("Canal \(channelNumber)", value: $channelNumber, in: 1...AT2Channel.channelCount)
                    .onChange(of: channelNumber) { newValue in
                        config.channel = newValue
                    }

                HStack {
                    Button {
                        Task { await readChannel() }
                    } label: {
                        Label("Lire", systemImage: "arrow.down.circle")
                    }
                    .disabled(isBusy)

                    Button {
                        Task { await writeChannel() }
                    } label: {
                        Label("Écrire", systemImage: "arrow.up.circle")
                    }
                    .disabled(isBusy)

                    Button {
                        selectChannel()
                    } label: {
                        Label("Basculer dessus", systemImage: "bolt.horizontal.circle")
                    }
                    .disabled(isBusy)
                }
                .buttonStyle(.bordered)

                if isBusy {
                    ProgressView()
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red).font(.footnote)
                }
            }

            Section("Fréquences (MHz)") {
                frequencyField("Réception", value: $config.rxMhz)
                frequencyField("Émission", value: $config.txMhz)
            }

            Section("Tonalités") {
                Picker("RX", selection: $config.rxTone) {
                    ForEach(toneOptions, id: \.self) { Text($0).tag($0) }
                }
                Picker("TX", selection: $config.txTone) {
                    ForEach(toneOptions, id: \.self) { Text($0).tag($0) }
                }
            }

            Section("Paramètres") {
                Toggle("Verrouillage occupé", isOn: $config.busyLock)
                Toggle("Bande étroite", isOn: $config.bandwidthNarrow)
                Toggle("Puissance haute", isOn: $config.highPower)
                Toggle("Ajouté au scan", isOn: $config.scanAdd)
                Toggle("Saut de fréquence", isOn: $config.hopOn)
                Toggle("Mode numérique", isOn: $config.modeDigital)
                Stepper("Clé de chiffrement: \(config.encryptKey)", value: $config.encryptKey, in: 0...31)
            }
        }
    }

    private func frequencyField(_ label: String, value: Binding<Double?>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("MHz", text: Binding<String>(
                get: { value.wrappedValue.map { String(format: "%.5f", $0) } ?? "" },
                set: { value.wrappedValue = Double($0.replacingOccurrences(of: ",", with: ".")) }
            ))
            .keyboardType(.decimalPad)
            .multilineTextAlignment(.trailing)
            .frame(width: 120)
        }
    }

    private func readChannel() async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            config = try await ble.readChannel(channelNumber)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func writeChannel() async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await ble.writeChannel(config)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func selectChannel() {
        errorMessage = nil
        do {
            try ble.selectChannel(channelNumber)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
