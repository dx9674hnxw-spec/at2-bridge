//
//  AT2Channel.swift
//  AT2Bridge
//
//  Per-channel read/write using the CPS-style frame dialect, ported from
//  `app/protocol/channel.py` (Python reference implementation in this repo).
//  Confirmed on real hardware (see that file's history / CONSIGNES_PROJET.md):
//  reads for channels 1, 11, 12 all matched independently-known values
//  (frequency, tone, mode, encrypt key). The WRITE side is reverse-engineered
//  from the same field order/encoding as the official CPS, but treat a write
//  as unconfirmed until you've done a write-then-read round trip yourself.
//
//  See /THIRD_PARTY_NOTICES.md for full attribution.
//

import Foundation

enum AT2Channel {
    static let channelCount = 30

    static let ctcssValues: [String] = [
        "67.0", "69.3", "71.9", "74.4", "77.0", "79.7", "82.5", "85.4", "88.5", "91.5",
        "94.8", "97.4", "100.0", "103.5", "107.2", "110.9", "114.8", "118.8", "123.0", "127.3",
        "131.8", "136.5", "141.3", "146.2", "150.0", "151.4", "156.7", "159.8", "162.2", "165.5",
        "167.9", "171.3", "173.8", "177.3", "179.9", "183.5", "186.2", "189.9", "192.8", "196.6",
        "199.5", "203.5", "206.5", "210.7", "218.1", "225.7", "229.1", "233.6", "241.8", "250.3",
        "254.1",
    ]

    static let dcsValues: [String] = [
        "D023", "D025", "D026", "D031", "D032", "D036", "D043", "D047", "D051", "D053",
        "D054", "D065", "D071", "D072", "D073", "D074", "D114", "D115", "D116", "D122",
        "D125", "D131", "D132", "D134", "D143", "D145", "D152", "D155", "D156", "D162",
        "D165", "D172", "D174", "D205", "D212", "D223", "D225", "D226", "D243", "D244",
        "D245", "D246", "D251", "D252", "D255", "D261", "D263", "D265", "D266", "D271",
        "D274", "D306", "D311", "D315", "D325", "D331", "D332", "D343", "D346", "D351",
        "D356", "D364", "D365", "D371", "D411", "D412", "D413", "D423", "D431", "D432",
        "D445", "D446", "D452", "D454", "D455", "D462", "D464", "D465", "D466", "D503",
        "D506", "D516", "D523", "D526", "D532", "D546", "D565", "D606", "D612", "D624",
        "D627", "D631", "D632", "D645", "D654", "D662", "D664", "D703", "D712", "D723",
        "D731", "D732", "D734", "D743", "D754",
    ]

    static func toneOptions() -> [String] {
        return ["OFF"] + ctcssValues.map { "\($0)Hz" } + dcsValues.map { "\($0)N" } + dcsValues.map { "\($0)I" }
    }

    static func toneLabel(value: UInt8, type: UInt8, polarity: UInt8) -> String {
        if value == 0x7F && type == 0x00 { return "OFF" }
        if type == 0x00 {
            return Int(value) < ctcssValues.count ? "\(ctcssValues[Int(value)])Hz" : "OFF"
        }
        if type == 0x01 {
            if Int(value) < dcsValues.count {
                return dcsValues[Int(value)] + (polarity == 0x01 ? "I" : "N")
            }
            return "OFF"
        }
        return "OFF"
    }

    enum ToneParseError: Error, LocalizedError {
        case unrecognized(String)
        var errorDescription: String? {
            switch self {
            case .unrecognized(let label): return "unrecognized tone label: \(label)"
            }
        }
    }

    /// Returns (value, type, polarity).
    static func parseToneLabel(_ label: String) throws -> (value: UInt8, type: UInt8, polarity: UInt8) {
        let text = label.trimmingCharacters(in: .whitespaces).uppercased()
        if text == "OFF" { return (0x7F, 0x00, 0x00) }
        if text.hasSuffix("N") || text.hasSuffix("I") {
            let base = String(text.dropLast())
            if let idx = dcsValues.firstIndex(of: base) {
                return (UInt8(idx), 0x01, text.hasSuffix("I") ? 0x01 : 0x00)
            }
        }
        var normalized = text
        if normalized.hasSuffix("HZ") { normalized.removeLast(2) }
        if let idx = ctcssValues.firstIndex(of: normalized) {
            return (UInt8(idx), 0x00, 0x00)
        }
        throw ToneParseError.unrecognized(label)
    }

    private static func encodeFreq(_ mhz: Double?) -> [UInt8] {
        guard let mhz else { return [0, 0, 0, 0] }
        let raw = UInt32((mhz * 100_000).rounded())
        var out = [UInt8](repeating: 0, count: 4)
        out[0] = UInt8(raw & 0xFF)
        out[1] = UInt8((raw >> 8) & 0xFF)
        out[2] = UInt8((raw >> 16) & 0xFF)
        out[3] = UInt8((raw >> 24) & 0xFF)
        return out
    }

    private static func decodeFreq(_ b: ArraySlice<UInt8>) -> Double? {
        let bytes = Array(b)
        guard bytes.count == 4 else { return nil }
        let raw = UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24)
        if raw == 0 { return nil }
        // round(raw / 100000, 5) -- raw is an integer so this just clears
        // any floating-point noise past the 5th decimal place.
        let value = Double(raw) / 100_000
        return (value * 100_000).rounded() / 100_000
    }

    // MARK: - CPS-style per-channel read/write (25-byte read response)

    /// Logical payload (before CPS frame wrapping) to read one channel's data:
    /// opcode=0x11 (read) + group=0x02 (communicationParames) + param=0x02
    /// (channelList) + 0x00 (reserved) + channel number (uint16 LE).
    static func buildChannelReadRequest(channel: Int) throws -> [UInt8] {
        guard (1...channelCount).contains(channel) else {
            throw ChannelError.channelOutOfRange(channel)
        }
        let ch = UInt16(channel)
        return [0x11, 0x02, 0x02, 0x00, UInt8(ch & 0xFF), UInt8((ch >> 8) & 0xFF)]
    }

    enum ChannelError: Error, LocalizedError {
        case channelOutOfRange(Int)
        case badReadBodyLength(Int)

        var errorDescription: String? {
            switch self {
            case .channelOutOfRange(let c): return "channel out of range: \(c)"
            case .badReadBodyLength(let n): return "expected a 25-byte channel read body, got \(n)"
            }
        }
    }

    /// Parses the 25-byte body of a CPS-style channel read response
    /// (CpsPacket.body when opcode=0x91, group=0x02, param=0x02).
    static func decodeChannelReadResponse(_ body: [UInt8]) throws -> ChannelConfig {
        guard body.count == 25 else { throw ChannelError.badReadBodyLength(body.count) }
        let channel = Int(body[2]) | (Int(body[3]) << 8)
        let rxMhz = decodeFreq(body[4..<8])
        let txMhz = decodeFreq(body[8..<12])
        let rxTone = toneLabel(value: body[12], type: body[13], polarity: body[16])
        let txTone = toneLabel(value: body[14], type: body[15], polarity: body[17])
        return ChannelConfig(
            channel: channel,
            rxMhz: rxMhz,
            txMhz: txMhz,
            rxTone: rxTone,
            txTone: txTone,
            busyLock: body[18] == 0x00,
            bandwidthNarrow: body[19] == 0x01,
            highPower: body[20] == 0x01,
            scanAdd: body[21] == 0x00,
            hopOn: body[22] == 0x01,
            modeDigital: body[23] == 0x01,
            encryptKey: Int(body[24])
        )
    }

    /// Encodes a ChannelConfig into the 23-byte field sequence expected after
    /// the opcode/group/param/reserved prefix in a CPS-style channel write
    /// request -- field order and widths match the official CPS's own
    /// channelInfosWrite table.
    static func buildChannelWriteFields(_ config: ChannelConfig) throws -> [UInt8] {
        let (rxVal, rxType, rxPol) = try parseToneLabel(config.rxTone)
        let (txVal, txType, txPol) = try parseToneLabel(config.txTone)
        var out: [UInt8] = []
        let ch = UInt16(config.channel)
        out += [UInt8(ch & 0xFF), UInt8((ch >> 8) & 0xFF)]
        out += encodeFreq(config.rxMhz)
        out += encodeFreq(config.txMhz)
        out += [rxVal, rxType, txVal, txType, rxPol, txPol]
        out += [
            config.busyLock ? 0x00 : 0x01,
            config.bandwidthNarrow ? 0x01 : 0x00,
            config.highPower ? 0x01 : 0x00,
            config.scanAdd ? 0x00 : 0x01,
            config.hopOn ? 0x01 : 0x00,
            config.modeDigital ? 0x01 : 0x00,
            UInt8(config.encryptKey & 0xFF),
        ]
        return out
    }

    /// Logical payload (before CPS frame wrapping) to write one channel:
    /// opcode=0x12 (write) + group=0x02 + param=0x02 + 0x00 (reserved) +
    /// the 23-byte field sequence from buildChannelWriteFields().
    static func buildChannelWriteRequest(_ config: ChannelConfig) throws -> [UInt8] {
        return [0x12, 0x02, 0x02, 0x00] + (try buildChannelWriteFields(config))
    }
}

/// Mirrors `app/protocol/channel.py::ChannelConfig`.
struct ChannelConfig: Identifiable, Equatable {
    var id: Int { channel }
    var channel: Int
    var rxMhz: Double?
    var txMhz: Double?
    var rxTone: String = "OFF"
    var txTone: String = "OFF"
    var busyLock: Bool = false
    var bandwidthNarrow: Bool = true
    var highPower: Bool = true
    var scanAdd: Bool = true
    var hopOn: Bool = false
    var modeDigital: Bool = false
    var encryptKey: Int = 0

    static func empty(channel: Int) -> ChannelConfig {
        ChannelConfig(channel: channel)
    }
}
