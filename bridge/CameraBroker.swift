import AVFoundation
import AppKit
import CoreImage
import CoreMediaIO
import ImageIO
import Network

// CAPTURE_CADENCE_BEGIN: kept pure for deterministic timing regression checks.
struct CaptureCadence {
    let interval: Double
    private var nextDeadline: Double?

    init(fps: Double) { interval = 1.0 / fps }

    mutating func accepts(_ now: Double) -> Bool {
        guard now.isFinite else { return false }
        guard let deadline = nextDeadline else {
            nextDeadline = now + interval
            return true
        }
        // Camera callbacks jitter around the requested cadence. Comparing to
        // the last accepted arrival time drops almost every other frame when
        // a callback arrives a fraction early. Keep the original deadline.
        guard now + min(0.003, interval * 0.05) >= deadline else { return false }
        let next = deadline + interval
        nextDeadline = next > now ? next : now + interval
        return true
    }
}
// CAPTURE_CADENCE_END

// CAPTURE_DIAGNOSTICS_BEGIN: Foundation-only helpers; never serialize frame data.
func diagnosticText(_ value: String, limit: Int = 512) -> String {
    String(value.replacingOccurrences(of: "\r", with: " ")
        .replacingOccurrences(of: "\n", with: " ").prefix(limit))
}

func diagnosticError(_ error: NSError, depth: Int = 0) -> [String: Any] {
    var result: [String: Any] = ["domain": diagnosticText(error.domain), "code": error.code]
    guard depth < 3 else { return result }
    result["description"] = diagnosticText(error.localizedDescription)
    if let reason = error.localizedFailureReason { result["failureReason"] = diagnosticText(reason) }
    if let recovery = error.localizedRecoverySuggestion { result["recoverySuggestion"] = diagnosticText(recovery) }
    result["userInfo"] = diagnosticDictionary(error.userInfo, depth: depth + 1)
    return result
}

func diagnosticValue(_ value: Any, depth: Int) -> Any {
    if let error = value as? NSError { return diagnosticError(error, depth: depth) }
    if let number = value as? NSNumber {
        return number.doubleValue.isFinite ? number : diagnosticText(number.stringValue)
    }
    if let string = value as? String { return diagnosticText(string) }
    if let data = value as? Data { return "<data: \(data.count) bytes omitted>" }
    if value is NSNull { return NSNull() }
    guard depth < 3 else { return "<\(type(of: value))>" }
    if let dictionary = value as? [AnyHashable: Any] {
        return diagnosticDictionary(dictionary, depth: depth + 1)
    }
    if let array = value as? [Any] {
        return array.prefix(8).map { diagnosticValue($0, depth: depth + 1) }
    }
    // Avoid invoking arbitrary descriptions or serializing capture buffers.
    return "<\(type(of: value))>"
}

func diagnosticDictionary(_ dictionary: [AnyHashable: Any], depth: Int = 0) -> [String: Any] {
    var result: [String: Any] = [:]
    let entries = dictionary.compactMap { key, value -> (String, Any)? in
        guard let key = key as? String else { return nil }
        return (key, value)
    }.sorted { $0.0 < $1.0 }
    for (key, value) in entries.prefix(16) {
        result[diagnosticText(key, limit: 128)] = diagnosticValue(value, depth: depth)
    }
    if entries.count > 16 { result["omittedEntries"] = entries.count - 16 }
    return result
}

func diagnosticJSON(_ fields: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
          let string = String(data: data, encoding: .utf8) else { return "{\"diagnosticEncodingFailed\":true}" }
    if data.count > 8192 {
        let shortened = ["diagnosticTruncated": true,
            "prefix": String(decoding: data.prefix(3072), as: UTF8.self)] as [String: Any]
        guard let data = try? JSONSerialization.data(withJSONObject: shortened, options: [.sortedKeys]),
              let result = String(data: data, encoding: .utf8) else { return "{\"diagnosticTruncated\":true}" }
        return result
    }
    return string
}
// CAPTURE_DIAGNOSTICS_END

func fourCC(_ subtype: FourCharCode) -> String {
    String(bytes: [24, 16, 8, 0].map { UInt8((subtype >> $0) & 255) }, encoding: .ascii) ?? String(subtype)
}

func finiteSeconds(_ time: CMTime) -> Any {
    let seconds = CMTimeGetSeconds(time)
    return seconds.isFinite ? seconds : NSNull()
}

func captureMode(_ device: AVCaptureDevice) -> [String: Any] {
    let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
    let subtype = CMFormatDescriptionGetMediaSubType(device.activeFormat.formatDescription)
    let duration = CMTimeGetSeconds(device.activeVideoMinFrameDuration)
    return ["identity": device.uniqueID, "name": device.localizedName,
        "width": dimensions.width, "height": dimensions.height,
        "avFoundationPixelFormat": fourCC(subtype), "avFoundationPixelFormatCode": subtype,
        "minimumFrameDurationSeconds": finiteSeconds(device.activeVideoMinFrameDuration),
        "maximumFrameDurationSeconds": finiteSeconds(device.activeVideoMaxFrameDuration),
        "configuredFps": duration.isFinite && duration > 0 ? 1 / duration : NSNull(),
        "usbWireFormat": "not measured", "usbPayloadReservation": "not measured"]
}

struct CameraBinding {
    let identityPrefix: String
    let port: UInt16
    let width: Int32
    let height: Int32
    let fps: Int32
    let rotation: Int
}

enum BrokerError: Error, CustomStringConvertible {
    case argument(String)
    case camera(String)

    var description: String {
        switch self {
        case .argument(let message), .camera(let message): return message
        }
    }
}

func parseBindings() throws -> [CameraBinding] {
    let arguments = Array(CommandLine.arguments.dropFirst())
    var bindings: [CameraBinding] = []
    var index = 0
    while index < arguments.count {
        guard arguments[index] == "--camera", index + 9 < arguments.count else {
            throw BrokerError.argument(
                "Expected --camera <identity> --port <port> --width <width> --height <height> --fps <fps>"
            )
        }
        let identity = arguments[index + 1]
        guard arguments[index + 2] == "--port",
              let port = UInt16(arguments[index + 3]),
              arguments[index + 4] == "--width",
              let width = Int32(arguments[index + 5]),
              arguments[index + 6] == "--height",
              let height = Int32(arguments[index + 7]),
              arguments[index + 8] == "--fps",
              let fps = Int32(arguments[index + 9]) else {
            throw BrokerError.argument("Invalid camera broker binding near \(identity)")
        }
        guard port > 0, width > 0, width <= 8192, height > 0, height <= 8192,
              fps > 0, fps <= 120 else {
            throw BrokerError.argument("Invalid capture dimensions, frame rate or port near \(identity)")
        }
        var rotation = 0
        var consumed = 10
        if index + 11 < arguments.count && arguments[index + 10] == "--rotation" {
            guard let parsed = Int(arguments[index + 11]), parsed == 0 || parsed == 180 else {
                throw BrokerError.argument("Camera rotation must be 0 or 180 near \(identity)")
            }
            rotation = parsed
            consumed = 12
        }
        bindings.append(CameraBinding(
            identityPrefix: identity,
            port: port,
            width: width,
            height: height,
            fps: fps,
            rotation: rotation
        ))
        index += consumed
    }
    guard !bindings.isEmpty else {
        throw BrokerError.argument("At least one camera binding is required")
    }
    guard Set(bindings.map(\.identityPrefix)).count == bindings.count,
          Set(bindings.map(\.port)).count == bindings.count else {
        throw BrokerError.argument("Camera identities and stream ports must be unique")
    }
    return bindings
}

// Compatibility for an already-running supervisor that still supplies several
// cameras in one launch: isolate each capture in its own signed child process.
// New supervisors launch one camera directly and never need this coordinator.
final class CameraProcessGroup {
    private var children: [UInt16: Process] = [:]
    private var retryAt: [UInt16: Date] = [:]
    private var failures: [UInt16: Int] = [:]
    private var startedAt: [UInt16: Date] = [:]
    private var timer: Timer?
    private var signals: [DispatchSourceSignal] = []
    private var stopping = false
    private let bindings: [CameraBinding]

    init(bindings: [CameraBinding]) { self.bindings = bindings }

    func start() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume()
            signals.append(source)
        }
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        guard !stopping else { return }
        for binding in bindings {
            if let existing = children[binding.port] {
                if existing.isRunning { continue }
                children.removeValue(forKey: binding.port)
                let stable = Date().timeIntervalSince(startedAt[binding.port] ?? Date()) >= 30
                let count = stable ? 1 : (failures[binding.port] ?? 0) + 1
                failures[binding.port] = count
                retryAt[binding.port] = Date(timeIntervalSinceNow: min(8, pow(2, Double(min(count - 1, 3)))))
            }
            if let retry = retryAt[binding.port], retry > Date() { continue }
            let child = Process()
            child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            child.arguments = [
                "--camera", binding.identityPrefix, "--port", String(binding.port),
                "--width", String(binding.width), "--height", String(binding.height),
                "--fps", String(binding.fps), "--rotation", String(binding.rotation)
            ]
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = FileHandle.nullDevice
            child.standardError = FileHandle.standardError
            do {
                try child.run()
                children[binding.port] = child
                startedAt[binding.port] = Date()
            } catch {
                retryAt[binding.port] = Date(timeIntervalSinceNow: 8)
                fputs("Camera process \(binding.port) could not start: \(error)\n", stderr)
            }
        }
    }

    private func stop() {
        guard !stopping else { return }
        stopping = true
        timer?.invalidate()
        for child in children.values where child.isRunning { child.terminate() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [self] in
            for child in children.values where child.isRunning { kill(child.processIdentifier, SIGKILL) }
            exit(0)
        }
    }
}

final class FrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let identity: String
    private let port: UInt16
    private let targetWidth: CGFloat = 720
    private var targetHeight: CGFloat = 1280
    private var phoneScreen = false
    private let rotation: Int
    private var reportedDimensions = ""
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let networkQueue: DispatchQueue
    private var connection: NWConnection?
    private var connected = false
    private var sending = false
    private var lastDeliveryAt = CFAbsoluteTimeGetCurrent()
    private var lastEncodedAt = CFAbsoluteTimeGetCurrent()
    private var watchdog: DispatchSourceTimer?
    private var lastSampleAt = CFAbsoluteTimeGetCurrent()
    private var receivedSample = false
    private var lastRecoveryAt = CFAbsoluteTimeGetCurrent()
    private var captureRecoveryAttempts = 0
    private var frameCadence: CaptureCadence
    var recoverCapture: (@Sendable () -> Void)?

    func diagnostic(_ message: String) {
        networkQueue.async { [weak self] in
            guard let self else { return }
            let kind = self.phoneScreen ? "mirror" : "camera"
            let url = URL(fileURLWithPath: "/tmp/phonebase-\(kind)-\(self.port).log")
            let line = "\(ISO8601DateFormatter().string(from: Date())) pid=\(ProcessInfo.processInfo.processIdentifier) identity=\(diagnosticText(self.identity, limit: 192)) \(diagnosticText(message, limit: 12000))\n"
            guard let bytes = line.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                let size = (try? handle.seekToEnd()) ?? 0
                if size > 1_000_000 { try? handle.truncate(atOffset: 0); try? handle.seek(toOffset: 0) }
                try? handle.write(contentsOf: bytes)
            } else { try? bytes.write(to: url, options: .atomic) }
        }
    }

    init(identity: String, port: UInt16, phoneScreen: Bool = false, phoneHeight: Int32 = 1560, fps: Int32 = 10, rotation: Int = 0) {
        self.phoneScreen = phoneScreen
        self.targetHeight = phoneScreen ? CGFloat(phoneHeight) : 1280
        self.identity = identity
        self.port = port
        self.rotation = rotation
        // Older supervisors launched the iPhone mirror with `--fps 10`.
        // Preserve compatibility during a rolling station upgrade while
        // raising interactive mirror delivery to the 15 FPS baseline.
        let effectiveFps = phoneScreen ? max(15, fps) : min(15, max(1, fps))
        self.frameCadence = CaptureCadence(fps: Double(effectiveFps))
        self.networkQueue = DispatchQueue(label: "phonebase.camera.network.\(port)")
        super.init()
        networkQueue.async { [weak self] in
            guard let self else { return }
            self.connect()
            do {
                let timer = DispatchSource.makeTimerSource(queue: self.networkQueue)
                timer.schedule(deadline: .now() + 12, repeating: 1)
                timer.setEventHandler { [weak self] in
                    guard let self else { return }
                    let now = CFAbsoluteTimeGetCurrent()
                    // Startup discovery may be slow. Once samples have arrived,
                    // distinguish capture starvation from a blocked TCP sender.
                    let sampleTimeout: Double = self.receivedSample ? 5 : 30
                    if now - self.lastSampleAt > sampleTimeout {
                        guard now - self.lastRecoveryAt > 15 else { return }
                        self.lastRecoveryAt = now
                        self.captureRecoveryAttempts += 1
                        if self.captureRecoveryAttempts > 2 {
                            self.diagnostic("capture recovery exhausted; requesting process restart")
                            // Flush the queued diagnostic before exiting.
                            self.networkQueue.async { exit(75) }
                            return
                        }
                        self.diagnostic("capture sample timeout; restarting session (attempt \(self.captureRecoveryAttempts))")
                        self.recoverCapture?()
                    } else if now - self.lastEncodedAt < 3 && now - self.lastDeliveryAt > 3 && self.connected {
                        self.diagnostic("transport stalled while capture is active; reconnecting TCP")
                        self.connected = false
                        self.connection?.cancel()
                    }
                }
                self.watchdog = timer
                timer.resume()
            }
        }
    }

    private func connect() {
        guard connection == nil, let endpointPort = NWEndpoint.Port(rawValue: port) else { return }
        let next = NWConnection(host: "127.0.0.1", port: endpointPort, using: .tcp)
        connection = next
        next.stateUpdateHandler = { [weak self, weak next] state in
            guard let self, self.connection === next else { return }
            switch state {
            case .ready:
                self.connected = true
                self.diagnostic("transport connected")
                print("Camera \(self.identity) connected to 127.0.0.1:\(self.port)")
            case .waiting:
                self.diagnostic("transport waiting; retrying")
                self.connected = false
                next?.cancel()
            case .failed, .cancelled:
                self.connected = false
                self.sending = false
                self.connection = nil
                self.networkQueue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.connect()
                }
            default:
                break
            }
        }
        next.start(queue: networkQueue)
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        let now = CFAbsoluteTimeGetCurrent()
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              frameCadence.accepts(now) else { return }
        networkQueue.async { [weak self] in
            guard let self else { return }
            self.lastSampleAt = now
            self.receivedSample = true
        }

        let image = CIImage(cvPixelBuffer: pixelBuffer)
        do {
            let dimensions = "\(Int(image.extent.width))x\(Int(image.extent.height))"
            if reportedDimensions != dimensions {
                reportedDimensions = dimensions
                diagnostic("capture dimensions \(dimensions)")
                if phoneScreen { try? ("Frame dimensions: " + dimensions).write(toFile: "/tmp/phonebase-mirror-dimensions.txt", atomically: true, encoding: .utf8) }
            }
        }
        if phoneScreen && abs(image.extent.width / image.extent.height - targetWidth / targetHeight) > 0.015 { return }
        // The fixture needs a small software lift after UVC auto-exposure, but
        // a fixed +3 EV clips white iPhone screens and makes the camera appear
        // to jump in brightness whenever the phone changes from a dark app to
        // a light one. Keep the wired mirror pixel-faithful and use a modest
        // lift plus highlight recovery only for the physical verification
        // camera. This preserves dark-screen visibility without erasing text
        // and screen edges on bright pages.
        let exposed = phoneScreen ? image : image
            .applyingFilter(
                "CIExposureAdjust",
                parameters: [kCIInputEVKey: 0.75]
            )
            .applyingFilter(
                "CIHighlightShadowAdjust",
                parameters: [
                    "inputShadowAmount": 0.35,
                    "inputHighlightAmount": 0.72,
                ]
            )
        let cameraOriented = phoneScreen ? exposed : exposed.oriented(.left)
        let oriented = rotation == 180 ? cameraOriented.oriented(.down) : cameraOriented
        let normalized = oriented.transformed(by: CGAffineTransform(
            translationX: -oriented.extent.minX,
            y: -oriented.extent.minY
        ))
        let scaled = normalized.transformed(by: CGAffineTransform(
            scaleX: targetWidth / normalized.extent.width,
            y: targetHeight / normalized.extent.height
        )).cropped(to: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        guard let jpeg = context.jpegRepresentation(
            of: scaled,
            colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.88]
        ) else { return }

        networkQueue.async { [weak self] in
            guard let self else { return }
            self.lastEncodedAt = now
            guard self.connected, !self.sending, let connection = self.connection else { return }
            self.sending = true
            connection.send(content: jpeg, completion: .contentProcessed { [weak self] error in
                guard let self, self.connection === connection else { return }
                self.sending = false
                if error != nil {
                    self.connected = false
                    self.connection?.cancel()
                } else {
                    self.lastDeliveryAt = CFAbsoluteTimeGetCurrent()
                    if self.captureRecoveryAttempts > 0 {
                        self.diagnostic("fresh frame delivered after capture recovery")
                        self.captureRecoveryAttempts = 0
                    }
                }
            })
        }
    }
}

final class CameraRuntime: @unchecked Sendable {
    let session: AVCaptureSession
    let sink: FrameSink
    let queue: DispatchQueue
    private let device: AVCaptureDevice
    private let phoneScreen: Bool
    private let captureFormat: AVCaptureDevice.Format
    private let captureDuration: CMTime
    private let sessionQueue: DispatchQueue
    private var observers: [NSObjectProtocol] = []
    private var activity: NSObjectProtocol?

    init(session: AVCaptureSession, sink: FrameSink, queue: DispatchQueue, device: AVCaptureDevice, phoneScreen: Bool, captureFormat: AVCaptureDevice.Format, captureDuration: CMTime) {
        self.session = session
        self.sink = sink
        self.queue = queue
        self.device = device
        self.phoneScreen = phoneScreen
        self.captureFormat = captureFormat
        self.captureDuration = captureDuration
        self.sessionQueue = DispatchQueue(label: "phonebase.capture.session.\(UUID().uuidString)")
        do {
            // A plugged-in station is doing continuous capture even when its
            // accessory app has no visible windows. Keep App Nap from pausing it.
            activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "Phonebase live iPhone USB capture")
            sink.recoverCapture = { [weak self] in self?.restartCapture() }
            for notification in [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification, AVCaptureSession.interruptionEndedNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: notification, object: session, queue: nil) { [weak self] note in
                    // macOS has no public InterruptionReasonKey API. Preserve
                    // bounded platform metadata and NSError chains when present.
                    var fields: [String: Any] = ["notification": note.name.rawValue,
                        "running": session.isRunning,
                        "activeAvFoundationMode": captureMode(device)]
                    fields["userInfo"] = diagnosticDictionary(note.userInfo ?? [:])
                    if let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError {
                        fields["error"] = diagnosticError(error)
                    }
                    self?.sink.diagnostic("session event \(diagnosticJSON(fields))")
                })
            }
            sink.diagnostic("capture runtime started; App Nap inhibited")
        }
    }

    func start() {
        sessionQueue.async {
            if self.phoneScreen {
                self.session.startRunning()
            } else {
                do {
                    // Keep the configuration lock through startup. Releasing it
                    // before startRunning lets macOS restore the default format
                    // and reserve bandwidth at 1080p before our first frame.
                    // FFmpeg uses the same ordering in its AVFoundation input.
                    try self.device.lockForConfiguration()
                    self.device.activeFormat = self.captureFormat
                    self.device.activeVideoMinFrameDuration = self.captureDuration
                    self.device.activeVideoMaxFrameDuration = self.captureDuration
                    self.session.startRunning()
                    self.device.unlockForConfiguration()
                } catch {
                    self.sink.diagnostic("could not start the requested capture format: \(diagnosticJSON(diagnosticError(error as NSError)))")
                    exit(75)
                }
            }
            self.sink.diagnostic("active capture \(diagnosticJSON(captureMode(self.device)))")
            guard !self.phoneScreen,
                  self.device.isExposureModeSupported(.continuousAutoExposure) else { return }
            do {
                // Some UVC cameras retain a locked, nearly black exposure from
                // the last application. Apply continuous exposure only after
                // capture is running; several UVC firmwares block if this is
                // changed before the stream has started.
                try self.device.lockForConfiguration()
                self.sink.diagnostic("enabling continuous automatic exposure")
                self.device.exposureMode = .continuousAutoExposure
                self.device.unlockForConfiguration()
                self.sink.diagnostic("continuous automatic exposure enabled")
            } catch {
                self.sink.diagnostic("automatic exposure unavailable: \(error)")
            }
        }
    }

    private func restartCapture() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.sink.diagnostic("session restart beginning")
            self.session.stopRunning()
            self.start()
            self.sink.diagnostic("session restart scheduled")
        }
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
    }
}

func matchingDevice(prefix: String) throws -> AVCaptureDevice {
    if prefix.hasPrefix("iphone:") {
        let identity = String(prefix.dropFirst(7))
        // Keep this client alive while macOS discovers or reconnects the assigned phone.
        // Exiting here on a slow discovery repeatedly tears down the screen-capture assistant.
        var logged = false
        while true {
            let matches = AVCaptureDevice.devices(for: .muxed).filter { $0.uniqueID == identity && $0.isConnected }
            if matches.count == 1, let device = matches.first { return device }
            guard matches.count < 2 else { throw BrokerError.camera("Ambiguous iPhone mirror identity") }
            if !logged { fputs("Waiting for the assigned USB screen source\n", stderr); logged = true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 2))
        }
    }
    let matches = AVCaptureDevice.devices(for: .video).filter {
        $0.uniqueID.lowercased().hasPrefix(prefix.lowercased())
    }
    guard matches.count == 1, let device = matches.first else {
        throw BrokerError.camera("Camera identity \(prefix) matched \(matches.count) devices")
    }
    guard device.localizedName.caseInsensitiveCompare("USB Camera2") == .orderedSame else {
        throw BrokerError.camera(
            "Refusing \(device.localizedName) (\(device.uniqueID)); only robot USB Camera2 is allowed"
        )
    }
    return device
}

func configure(_ binding: CameraBinding) throws -> CameraRuntime {
    let device = try matchingDevice(prefix: binding.identityPrefix)
    let session = AVCaptureSession()
    session.beginConfiguration()
    if binding.identityPrefix.hasPrefix("iphone:") {
        session.sessionPreset = .high
    } else {
        // macOS does not support inputPriority. Avoid starting every USB camera
        // at the default high/1080p preset before applying its smaller format.
        let startupPreset: AVCaptureSession.Preset
        switch (binding.width, binding.height) {
        case (1920, 1080): startupPreset = .hd1920x1080
        case (1280, 720): startupPreset = .hd1280x720
        case (960, 540): startupPreset = AVCaptureSession.Preset(rawValue: "AVCaptureSessionPreset960x540")
        case (320, 240): startupPreset = AVCaptureSession.Preset(rawValue: "AVCaptureSessionPreset320x240")
        default: startupPreset = .vga640x480
        }
        session.sessionPreset = startupPreset
    }
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }

    // Identical UVC cameras expose YUY2 before NV12. Prefer NV12 to avoid
    // choosing the high-bandwidth packed format just because it is first.
    let formats = device.formats.sorted { left, right in
        let preferred = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        return CMFormatDescriptionGetMediaSubType(left.formatDescription) == preferred &&
            CMFormatDescriptionGetMediaSubType(right.formatDescription) != preferred
    }
    if let selection = formats.compactMap({ format -> (AVCaptureDevice.Format, AVFrameRateRange)? in
        let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        guard dimensions.width == binding.width, dimensions.height == binding.height else { return nil }
        guard let range = format.videoSupportedFrameRateRanges.first(where: { range in
            range.minFrameRate <= Double(binding.fps) + 0.1 &&
                range.maxFrameRate >= Double(binding.fps) - 0.1
        }) else { return nil }
        return (format, range)
    }).first {
        device.activeFormat = selection.0
        // Honor the requested cadence instead of the format's maximum FPS.
        let duration = selection.1.minFrameRate == selection.1.maxFrameRate
            ? selection.1.minFrameDuration
            : CMTime(value: 1, timescale: binding.fps)
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
    } else if !binding.identityPrefix.hasPrefix("iphone:") {
        throw BrokerError.camera(
            "Camera \(binding.identityPrefix) does not support \(binding.width)x\(binding.height)@\(binding.fps)"
        )
    }

    let captureFormat = device.activeFormat
    let captureDuration = device.activeVideoMinFrameDuration
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else {
        throw BrokerError.camera("Cannot add camera input \(binding.identityPrefix)")
    }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    ]
    guard session.canAddOutput(output) else {
        throw BrokerError.camera("Cannot add camera output \(binding.identityPrefix)")
    }
    session.addOutput(output)
    let sink = FrameSink(
        identity: device.uniqueID,
        port: binding.port,
        phoneScreen: binding.identityPrefix.hasPrefix("iphone:"),
        phoneHeight: binding.height,
        fps: binding.fps,
        rotation: binding.rotation
    )
    let selectionDiagnostic: [String: Any] = [
        "requestedWidth": binding.width, "requestedHeight": binding.height, "requestedFps": binding.fps,
        "avFoundationMode": captureMode(device),
        "deliveredMaximumFps": binding.identityPrefix.hasPrefix("iphone:") ? max(15, binding.fps) : min(15, binding.fps),
        "deliveredJpegWidth": 720, "deliveredJpegHeight": binding.identityPrefix.hasPrefix("iphone:") ? binding.height : 1280,
        "captureKind": binding.identityPrefix.hasPrefix("iphone:") ? "wired-iphone-mirror" : "physical-uvc-camera",
        "note": "AVFoundation format and delivered JPEG cadence do not measure USB endpoint reservation"
    ]
    sink.diagnostic("selected capture format \(diagnosticJSON(selectionDiagnostic))")
    let queue = DispatchQueue(label: "phonebase.camera.frames.\(binding.port)")
    output.setSampleBufferDelegate(sink, queue: queue)
    session.commitConfiguration()
    print("Bound \(device.uniqueID) -> 127.0.0.1:\(binding.port)")
    return CameraRuntime(
        session: session,
        sink: sink,
        queue: queue,
        device: device,
        phoneScreen: binding.identityPrefix.hasPrefix("iphone:"),
        captureFormat: captureFormat,
        captureDuration: captureDuration
    )
}

func cameraAuthorized() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        return true
    case .notDetermined:
        var completed = false
        var granted = false
        AVCaptureDevice.requestAccess(for: .video) { value in
            DispatchQueue.main.async { granted = value; completed = true }
        }
        let deadline = Date(timeIntervalSinceNow: 60)
        while !completed && Date() < deadline { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1)) }
        return granted
    default:
        return false
    }
}

// Children must not inherit the coordinator's ignored termination signals.
signal(SIGTERM, SIG_DFL)
signal(SIGINT, SIG_DFL)

do {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()
    if CommandLine.arguments.count == 3 && ["--inspect-formats", "--inspect-device"].contains(CommandLine.arguments[1]) {
        // Property inspection only: never creates an input, capture session or
        // stream, and never changes the device format or a USB setting.
        let device = try matchingDevice(prefix: CommandLine.arguments[2])
        let formats: [[String: Any]] = device.formats.enumerated().map { index, format in
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
            return ["index": index, "width": size.width, "height": size.height, "codec": fourCC(subtype),
                    "subtype": subtype,
                    "rates": format.videoSupportedFrameRateRanges.map { ["min": $0.minFrameRate, "max": $0.maxFrameRate,
                        "minimumDurationSeconds": finiteSeconds($0.minFrameDuration),
                        "maximumDurationSeconds": finiteSeconds($0.maxFrameDuration)] }]
        }
        let result: Any = CommandLine.arguments[1] == "--inspect-formats" ? formats : [
            "identity": device.uniqueID, "name": device.localizedName, "connected": device.isConnected,
            "activeAvFoundationMode": captureMode(device), "formats": formats,
            "inspectionOnly": true,
            "note": "AVFoundation formats describe application media. USB wire format, endpoint payload and reserved bandwidth require separate USB inspection."
        ] as [String: Any]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        exit(0)
    }
    guard cameraAuthorized() else {
        throw BrokerError.camera("Camera permission is not granted")
    }
    let bindings = try parseBindings()
    if bindings.count > 1 {
        let group = CameraProcessGroup(bindings: bindings)
        group.start()
        withExtendedLifetime(group) { RunLoop.current.run() }
        exit(0)
    }
    if bindings.contains(where: { $0.identityPrefix.hasPrefix("iphone:") }) {
        var address = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var enabled: UInt32 = 1
        guard CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &enabled) == 0 else { throw BrokerError.camera("iPhone screen discovery failed") }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 3))
    }
    let runtimes = try bindings.map(configure)
    for runtime in runtimes {
        runtime.start()
    }
    withExtendedLifetime(runtimes) {
        RunLoop.current.run()
    }
} catch {
    let details = diagnosticJSON(["message": diagnosticText(String(describing: error)),
        "error": diagnosticError(error as NSError)])
    fputs("Phonebase camera broker: \(details)\n", stderr)
    exit(1)
}
