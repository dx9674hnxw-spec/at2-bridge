//
//  AT2Frame.swift
//  AT2Bridge
//
//  AT2 frame codec, ported from `app/protocol/frame.py` (Python reference
//  implementation in this repo).
//
//  Two distinct frame dialects share the same head/tail markers and CRC16
//  algorithm (poly 0x1021, init 0x1234):
//
//  - "Legacy" dialect (ported from the reference Android app's BLE
//    protocol): AA55 <len:1> <0x00 + family + command + body> <crc16 le:2> 77EE.
//    The length byte excludes the leading 0x00. Used for offline messaging,
//    real-time PTT, and device settings.
//
//  - "CPS" dialect (found by decompiling the official Windows CPS):
//    AA55 <len:2 LE> <payload, no leading 0x00> <crc16 le:2> 77EE.
//    Used for reading/writing an individual channel.
//
//  See /THIRD_PARTY_NOTICES.md for full attribution.
//

import Foundation

enum FrameError: Error, LocalizedError {
    case emptyPayload
    case invalidLeadingByte
    case payloadTooLong(Int)

    var errorDescription: String? {
        switch self {
        case .emptyPayload: return "payload must not be empty"
        case .invalidLeadingByte: return "AT2 payload must start with 0x00"
        case .payloadTooLong(let n): return "payload too long: \(n)"
        }
    }
}

enum AT2Frame {
    static let head: [UInt8] = [0xAA, 0x55]
    static let tail: [UInt8] = [0x77, 0xEE]

    // MARK: - Legacy dialect (messaging / PTT / device settings)

    /// Wrap a payload (must start with 0x00) into a full legacy-dialect AT2 frame.
    static func encodeFrame(_ payload: [UInt8]) throws -> [UInt8] {
        guard !payload.isEmpty else { throw FrameError.emptyPayload }
        guard payload[0] == 0x00 else { throw FrameError.invalidLeadingByte }
        let bodyLen = payload.count - 1
        guard bodyLen <= 0xFF else { throw FrameError.payloadTooLong(payload.count) }

        let crc = CRC16.ccitt(Array(payload.dropFirst()))
        var out: [UInt8] = []
        out += head
        out.append(UInt8(bodyLen))
        out += payload
        out.append(UInt8(crc & 0xFF))
        out.append(UInt8((crc >> 8) & 0xFF))
        out += tail
        return out
    }

    /// Try to find and decode one complete legacy-dialect frame inside `buf`.
    /// Returns (payload, bytesConsumed) or (nil, 0) if nothing usable yet, or
    /// (nil, n) if a garbled header should be dropped so the caller can resync.
    static func tryDecodeFrame(_ buf: [UInt8]) -> (payload: [UInt8]?, consumed: Int) {
        guard let start = firstIndex(of: head, in: buf) else { return (nil, 0) }
        guard start + 7 <= buf.count else { return (nil, 0) }
        let length = Int(buf[start + 2])

        // Variant A: length excludes leading 0x00 (payload = 0x00 + len bytes)
        let endA = start + 3 + (length + 1) + 2 + 2
        if endA <= buf.count, Array(buf[(endA - 2)..<endA]) == tail {
            let payloadStart = start + 3
            let payloadEnd = payloadStart + length + 1
            let payload = Array(buf[payloadStart..<payloadEnd])
            if !payload.isEmpty, payload[0] == 0x00 {
                let gotCrc = UInt16(buf[payloadEnd]) | (UInt16(buf[payloadEnd + 1]) << 8)
                if CRC16.ccitt(Array(payload.dropFirst())) == gotCrc {
                    return (payload, endA)
                }
            }
        }

        // Variant B: length is the raw body length, no leading 0x00 stored
        let endB = start + 3 + length + 2 + 2
        if endB <= buf.count, Array(buf[(endB - 2)..<endB]) == tail {
            let payloadStart = start + 3
            let payloadEnd = payloadStart + length
            let body = Array(buf[payloadStart..<payloadEnd])
            let gotCrc = UInt16(buf[payloadEnd]) | (UInt16(buf[payloadEnd + 1]) << 8)
            if CRC16.ccitt(body) == gotCrc {
                return ([0x00] + body, endB)
            }
        }

        // Header found but frame incomplete/garbled: drop just the header
        // so the caller can resync on the next AA55 occurrence.
        return (nil, start + 2)
    }

    struct At2Packet {
        let family: UInt8
        let command: UInt8
        let body: [UInt8]
    }

    /// Turn a decoded frame payload (0x00 + family + command + body) into a packet.
    static func decodePacket(_ payload: [UInt8]) -> At2Packet? {
        guard payload.count >= 4, payload[0] == 0x00 else { return nil }
        return At2Packet(family: payload[1], command: payload[2], body: Array(payload.dropFirst(3)))
    }

    static func buildPayload(family: UInt8, command: UInt8, body: [UInt8] = []) -> [UInt8] {
        return [0x00, family, command] + body
    }

    // MARK: - CPS dialect (per-channel read/write)

    /// Wrap a payload (e.g. [0x11, 0x02, 0x02, 0x00, ...]) into a full
    /// CPS-style frame: AA55 + LEN(2 bytes LE) + payload + CRC16(2 bytes LE) + 77EE.
    static func encodeCPSFrame(_ payload: [UInt8]) throws -> [UInt8] {
        guard !payload.isEmpty else { throw FrameError.emptyPayload }
        guard payload.count <= 0xFFFF else { throw FrameError.payloadTooLong(payload.count) }
        let crc = CRC16.ccitt(payload)
        var out: [UInt8] = []
        out += head
        let len = UInt16(payload.count)
        out.append(UInt8(len & 0xFF))
        out.append(UInt8((len >> 8) & 0xFF))
        out += payload
        out.append(UInt8(crc & 0xFF))
        out.append(UInt8((crc >> 8) & 0xFF))
        out += tail
        return out
    }

    /// CPS-style counterpart to tryDecodeFrame(): same head/tail markers and
    /// CRC algorithm, but a 2-byte little-endian length field and no leading 0x00.
    static func tryDecodeCPSFrame(_ buf: [UInt8]) -> (payload: [UInt8]?, consumed: Int) {
        guard let start = firstIndex(of: head, in: buf) else { return (nil, 0) }
        guard start + 8 <= buf.count else { return (nil, 0) }
        let length = Int(buf[start + 2]) | (Int(buf[start + 3]) << 8)
        let end = start + 4 + length + 2 + 2
        if end <= buf.count, Array(buf[(end - 2)..<end]) == tail {
            let payloadStart = start + 4
            let payloadEnd = payloadStart + length
            let payload = Array(buf[payloadStart..<payloadEnd])
            let gotCrc = UInt16(buf[payloadEnd]) | (UInt16(buf[payloadEnd + 1]) << 8)
            if CRC16.ccitt(payload) == gotCrc {
                return (payload, end)
            }
        }
        return (nil, start + 2)
    }

    /// Decoded CPS-style response: opcode (e.g. 0x91 = 0x11|0x80 for a read
    /// reply), group, param, and whatever body bytes follow.
    struct CpsPacket {
        let opcode: UInt8
        let group: UInt8
        let param: UInt8
        let body: [UInt8]
    }

    static func decodeCPSPacket(_ payload: [UInt8]) -> CpsPacket? {
        guard payload.count >= 3 else { return nil }
        return CpsPacket(opcode: payload[0], group: payload[1], param: payload[2], body: Array(payload.dropFirst(3)))
    }

    // MARK: - Helpers

    private static func firstIndex(of needle: [UInt8], in haystack: [UInt8]) -> Int? {
        guard needle.count <= haystack.count, !needle.isEmpty else { return nil }
        let last = haystack.count - needle.count
        if last < 0 { return nil }
        for i in 0...last {
            if Array(haystack[i..<(i + needle.count)]) == needle {
                return i
            }
        }
        return nil
    }
}
