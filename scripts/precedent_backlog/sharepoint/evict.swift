// Hands OneDrive files back to the cloud after they have been read, so a
// bulk read of cloud-only files never fills the disk. Build once with:
//   swiftc -O evict.swift -o evict
import Foundation
var failed = 0
for p in CommandLine.arguments.dropFirst() {
    do { try FileManager.default.evictUbiquitousItem(at: URL(fileURLWithPath: p)) }
    catch { failed += 1; FileHandle.standardError.write("evict failed: \(p): \(error)\n".data(using: .utf8)!) }
}
exit(failed == 0 ? 0 : 1)
