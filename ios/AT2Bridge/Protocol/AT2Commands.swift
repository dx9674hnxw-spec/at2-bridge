//
//  AT2Commands.swift
//  AT2Bridge
//
//  Legacy-dialect command payload builders, ported from
//  `app/protocol/commands.py` (Python reference implementation in this
//  repo), itself ported from `At2Commands.kt` (Apache-2.0). Only the
//  "quick select channel" command is included here (BLE-minimal scope);
//  see the Python file for device settings / messaging / PTT builders if
//  this app grows beyond channel read/write.
//
//  See /THIRD_PARTY_NOTICES.md for full attribution.
//

import Foundation

enum AT2Commands {
    static let familyQuery: UInt8 = 0x01
    static let familySet: UInt8 = 0x02

    enum Side: String {
        case a = "A"
        case b = "B"

        var code: UInt8 { self == .a ? 0x01 : 0x02 }
    }

    /// Select the active channel (side A of the dual-watch pair when dual
    /// watch is off, which is what "the" active channel means in that case).
    /// Family/command is 0x02/0x02 with the channel opcode (0x0E) as the
    /// first body byte -- not 0x02/0x0E.
    static func selectChannel(_ channel: Int) throws -> [UInt8] {
        guard (1...30).contains(channel) else {
            throw AT2Channel.ChannelError.channelOutOfRange(channel)
        }
        return selectDualWatchChannel(side: .a, channel: channel)
    }

    static func selectDualWatchChannel(side: Side, channel: Int) -> [UInt8] {
        return AT2Frame.buildPayload(family: familySet, command: 0x02, body: [0x0E, side.code, UInt8(channel), 0x00])
    }
}
