//
//  LogConsoleView.swift
//  AT2Bridge
//
//  Collapsible raw TX/RX log, useful when comparing frames against the
//  Python reference implementation or the reference Android app while
//  confirming protocol behavior on real hardware.
//

import SwiftUI

struct LogConsoleView: View {
    @ObservedObject var ble: AT2BLEManager
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(ble.log.enumerated()), id: \.offset) { index, line in
                            Text(line)
                                .font(.system(.caption2, design: .monospaced))
                                .id(index)
                        }
                    }
                    .padding(.horizontal)
                }
                .frame(maxHeight: 200)
                .onChange(of: ble.log.count) { _ in
                    proxy.scrollTo(ble.log.count - 1, anchor: .bottom)
                }
            }
        } label: {
            Text("Journal (\(ble.log.count))")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal)
        .padding(.vertical, 4)
    }
}
