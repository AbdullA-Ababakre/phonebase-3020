# Set up a station

The operator workflow for bringing physical devices online and preparing them for customers.

## Station requirements

- A Mac with supported PhoneUse runtime dependencies.
- For each arm: controller USB, stable power, UVC camera, and a phone in the fixture.
- A stable identity for every controller and camera; do not rely on USB enumeration numbers.

## Install the runtime

```bash
curl -fsSL --proto '=https' --tlsv1.2 \
  https://phoneuse.com/install.sh | bash
phonebase onboard
phonebase doctor
```

Open [the local Dashboard](http://127.0.0.1:3020). This localhost address is for the Mac physically connected to the station. Allow the PhoneUse Camera permission when macOS requests it.

## Prepare each physical device

- Check that Connections identifies the correct controller and camera.
- Inspect and clear the physical workspace, then explicitly confirm mechanical Home.
- Position the phone and complete phone-model selection and screen recognition.
- Verify the detected corners. Use manual calibration when the automatic path cannot confidently validate the setup.
- Check live tap capability and perform a supervised acceptance workflow before assigning the device.

## Expose the customer gateway

Use a fixed HTTPS hostname backed by a named tunnel to localhost:3015. Configure the exact console origin, a private admin token, and PHONEBASE_REMOTE_PUBLIC_URL. Keep local control API :3013 bound to localhost. Customer keys are generated through [customer access](/docs/customer-access).

## Scale hardware identity

Use `config/device-fleet.json` to assign a stable deviceId, controller serial identity, camera identity, driver port, and verified calibration profile to each arm. Ambiguous hardware must remain unassigned. Qualify USB bandwidth, power, camera frame rates, and recovery under the actual number of arms before customer rollout.
