import importlib.util
from pathlib import Path
import plistlib
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('remote_installer', ROOT / 'scripts/install_remote_services_macos.py')
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class RemoteServiceTests(unittest.TestCase):
    def test_only_remote_services_are_installed_and_credentials_are_not_embedded(self):
        root = Path('/station with spaces')
        services = INSTALLER.service_payloads(root, '/bin/node', '/bin/cloudflared', root / '.runtime/token')
        self.assertEqual([s['Label'] for s in services], list(INSTALLER.LABELS))
        self.assertEqual(len(services), 3)
        for service in services:
            self.assertTrue(service['KeepAlive'])
            self.assertTrue(service['RunAtLoad'])
            self.assertEqual(service['ThrottleInterval'], 10)
            self.assertEqual(service['WorkingDirectory'], str(root))
            self.assertEqual(set(service['EnvironmentVariables']), {'PATH'})
            self.assertEqual(plistlib.loads(plistlib.dumps(service)), service)
        self.assertEqual(services[0]['ProgramArguments'][1:], ['--import', 'tsx', 'bridge/remote_gateway.ts'])
        self.assertEqual(services[1]['ProgramArguments'][1:], ['scripts/public_console_proxy.mjs'])
        command = services[2]['ProgramArguments']
        self.assertIn('--token-file', command)
        self.assertNotIn('--token', command)
        self.assertNotIn('--no-tls-verify', command)
        self.assertEqual(command[-1], str(root / '.runtime/token'))

    def test_public_ports_are_reserved_from_new_hardware_enrollment(self):
        source = (ROOT / 'bridge/fleet_supervisor.ts').read_text()
        self.assertIn('3021, // Legacy public Console', source)
        self.assertIn('3040, // Read-only public Console', source)


if __name__ == '__main__':
    unittest.main()
