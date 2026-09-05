//
//  DeviceListView.swift
//  AT2Bridge
//
//  Device scan/connect screen, shown before a BLE link to the AT2 is
//  established (see README.md "Starting a scan" for the recommended
//  pairing steps: close any other app connected to the radio, and
//  toggle the radio's Bluetooth off/on to restart its advertising).
//

import SwiftUI

struct DeviceListView: View {
    @ObservedObject var ble: AT2BLEManager

    var body: some View {
        VStack(spacing: 12) {
            if ble.discovered.isEmpty {
                // Hand-rolled empty state instead of ContentUnavailableView
                // (iOS 17+ only) to keep the iOS 16 deployment target.
                VStack(spacing: 8) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary)
                    Text("Aucun appareil trouvé")
                        .font(.headline)
                    Text("Lancez une recherche pour détecter un talkie-walkie AT2_… à proximité.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(ble.discovered) { device in
                    Button {
                        ble.connect(device)
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(device.name).font(.body)
                                Text(device.id.uuidString).font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(device.rssi) dBm").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .listStyle(.plain)
            }

            Button {
                if case .scanning = ble.state {
                    ble.stopScan()
                } else {
                    ble.startScan()
                }
            } label: {
                if case .scanning = ble.state {
                    Label("Arrêter la recherche", systemImage: "stop.circle")
                } else {
                    Label("Rechercher un AT2", systemImage: "magnifyingglass")
                }
            }
            .buttonStyle(.borderedProminent)
            .padding(.bottom, 8)
        }
    }
}
