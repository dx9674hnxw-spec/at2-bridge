//
//  CRC16.swift
//  AT2Bridge
//
//  CRC-16/CCITT (non-reflected), polynomial 0x1021, init 0x1234.
//  Ported from `app/protocol/frame.py::crc16_ccitt` (Python reference
//  implementation in this repo), itself ported from the Kotlin reference
//  app `Baofeng-ALERVITES-AT2-Android` (Apache License 2.0).
//  See /THIRD_PARTY_NOTICES.md for full attribution.
//

import Foundation

enum CRC16 {
    static let poly: UInt16 = 0x1021
    static let initValue: UInt16 = 0x1234

    /// CRC-16/CCITT (non-reflected), poly 0x1021, init 0x1234.
    static func ccitt(_ data: [UInt8]) -> UInt16 {
        var crc = initValue
        for byte in data {
            crc ^= UInt16(byte) << 8
            for _ in 0..<8 {
                if crc & 0x8000 != 0 {
                    crc = (crc << 1) ^ poly
                } else {
                    crc = crc << 1
                }
            }
        }
        return crc
    }
}
