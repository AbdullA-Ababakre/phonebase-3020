import pathlib
import shutil
import subprocess
import tempfile
import unittest


class CameraDiagnosticsTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('swiftc'), 'Swift compiler required')
    def test_runtime_error_chain_is_useful_bounded_and_omits_binary_data(self):
        source = (pathlib.Path(__file__).resolve().parents[1] / 'bridge/CameraBroker.swift').read_text()
        helpers = source.split('// CAPTURE_DIAGNOSTICS_BEGIN:', 1)[1].split('// CAPTURE_DIAGNOSTICS_END', 1)[0]
        helpers = helpers.split('\n', 1)[1]
        checks = r'''
let usb = NSError(domain: "IOUSBHostErrorDomain", code: -536870211,
    userInfo: [NSLocalizedDescriptionKey: "Endpoint allocation\nfailed", "payloadBytes": 3072])
let capture = NSError(domain: "AVFoundationErrorDomain", code: -11800,
    userInfo: [NSLocalizedDescriptionKey: "Camera unavailable", NSUnderlyingErrorKey: usb,
               NSLocalizedFailureReasonErrorKey: "Insufficient resources",
               NSLocalizedRecoverySuggestionErrorKey: "Use another USB upstream path",
               "binary": Data(repeating: 65, count: 20000)])
let info = diagnosticError(capture)
precondition(info["domain"] as? String == "AVFoundationErrorDomain")
precondition(info["code"] as? Int == -11800)
precondition(info["failureReason"] as? String == "Insufficient resources")
let userInfo = info["userInfo"] as! [String: Any]
let underlying = userInfo[NSUnderlyingErrorKey] as! [String: Any]
precondition(underlying["domain"] as? String == "IOUSBHostErrorDomain")
precondition(underlying["code"] as? Int == -536870211)
precondition((underlying["description"] as! String) == "Endpoint allocation failed")
precondition(userInfo["binary"] as? String == "<data: 20000 bytes omitted>")
let encoded = diagnosticJSON(["error": info])
precondition(!encoded.contains("\n") && !encoded.contains("\r"))
let decoded = try JSONSerialization.jsonObject(with: Data(encoded.utf8))
precondition(decoded is [String: Any])

let large = Dictionary(uniqueKeysWithValues: (0..<100).map { ("key\($0)", String(repeating: "\"🚀", count: 10000)) })
let bounded = diagnosticJSON(["nested": ["items": large], "badNumber": diagnosticValue(Double.nan, depth: 0)])
precondition(bounded.utf8.count <= 8192, "A notification must not produce an unbounded log line")
let decodedBounded = try JSONSerialization.jsonObject(with: Data(bounded.utf8))
precondition(decodedBounded is [String: Any])
precondition(!bounded.contains("diagnosticEncodingFailed"), "Non-finite numbers must be represented safely")
let truncated = diagnosticDictionary(large)
precondition(truncated.count == 17 && truncated["omittedEntries"] as? Int == 84)
print("camera diagnostic error-chain, metadata, binary-omission and size checks passed")
'''
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            (path / 'main.swift').write_text('import Foundation\n' + helpers + '\n' + checks)
            compiled = subprocess.run(['swiftc', str(path / 'main.swift'), '-o', str(path / 'check')], capture_output=True, text=True, timeout=30)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            result = subprocess.run([str(path / 'check')], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
