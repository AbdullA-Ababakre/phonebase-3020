import pathlib
import shutil
import subprocess
import tempfile
import unittest


class CameraCadenceTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('swiftc'), 'Swift compiler required')
    def test_camera_jitter_preserves_rate_without_backlog_bursts(self):
        source = (pathlib.Path(__file__).resolve().parents[1] / 'bridge/CameraBroker.swift').read_text()
        cadence = source.split('// CAPTURE_CADENCE_BEGIN:', 1)[1].split('// CAPTURE_CADENCE_END', 1)[0]
        cadence = cadence.split('\n', 1)[1]
        checks = r'''
var sameRate = CaptureCadence(fps: 15)
var sameCount = 0
for i in 0..<600 {
    let jitter = i % 2 == 0 ? -0.001 : 0.001
    if sameRate.accepts(Double(i) / 15 + jitter) { sameCount += 1 }
}
precondition(sameCount == 600, "15fps callbacks with 1ms jitter must not collapse to half rate")

var halfRate = CaptureCadence(fps: 15)
var halfCount = 0
for i in 0..<1800 {
    let jitter = i % 3 == 0 ? -0.0015 : 0.0015
    if halfRate.accepts(Double(i) / 30 + jitter) { halfCount += 1 }
}
precondition((899...901).contains(halfCount), "30fps input must retain approximately 15fps over a minute")

var delayed = CaptureCadence(fps: 10)
precondition(delayed.accepts(0))
precondition(!delayed.accepts(0.02))
precondition(delayed.accepts(0.099))
precondition(delayed.accepts(10))
precondition(!delayed.accepts(10.001), "A long pause must not create a catch-up burst")
precondition(!delayed.accepts(Double.nan))
precondition(!delayed.accepts(Double.infinity))
print("camera cadence jitter/rate/pause checks passed")
'''
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            (path / 'main.swift').write_text(cadence + '\n' + checks)
            subprocess.run(['swiftc', str(path / 'main.swift'), '-o', str(path / 'check')], check=True, capture_output=True, timeout=30)
            result = subprocess.run([str(path / 'check')], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
