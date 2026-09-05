//
//  ContentView.swift
//  AT2Bridge
//

import SwiftUI

struct ContentView: View {
    @StateObject private var ble = AT2BLEManager()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                StatusHeaderView(ble: ble)
                Divider()

                switch ble.state {
                case .connected:
                    ChannelPanelView(ble: ble)
                default:
                    DeviceListView(ble: ble)
                }

                Divider()
                LogConsoleView(ble: ble)
            }
            .navigationTitle("AT2 Bridge")
        }
    }
}

private struct StatusHeaderView: View {
    @ObservedObject var ble: AT2BLEManager

    var body: some View {
        HStack {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            if case .connected = ble.state {
                Button("Déconnecter", role: .destructive) {
                    ble.disconnect()
                }
                .font(.subheadline)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private var label: String {
        switch ble.state {
        case .poweredOff: return "Bluetooth désactivé"
        case .unauthorized: return "Bluetooth non autorisé pour cette app"
        case .idle: return "Non connecté"
        case .scanning: return "Recherche en cours…"
        case .connecting(let name): return "Connexion à \(name)…"
        case .connected(let name): return "Connecté: \(name)"
        case .failed(let reason): return "Échec: \(reason)"
        }
    }

    private var color: Color {
        switch ble.state {
        case .connected: return .green
        case .scanning, .connecting: return .yellow
        case .failed, .unauthorized, .poweredOff: return .red
        case .idle: return .gray
        }
    }
}

#Preview {
    ContentView()
}
