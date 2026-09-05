//
//  AT2BridgeApp.swift
//  AT2Bridge
//
//  Native iOS companion to the AT2 Bridge web app, using CoreBluetooth
//  instead of Web Bluetooth (unavailable on iOS Safari/WebKit -- see
//  README.md "Known limitations"). BLE-minimal scope for this first
//  version: scan/connect, single-channel read/write, quick channel select.
//

import SwiftUI

@main
struct AT2BridgeApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
