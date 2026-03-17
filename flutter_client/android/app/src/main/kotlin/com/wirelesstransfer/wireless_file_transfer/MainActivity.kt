package com.wirelesstransfer.wireless_file_transfer

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    private val CHANNEL = "com.localbeam/downloads"
    private val RECORDER_CHANNEL = "com.localbeam/recorder"
    private val PLAYER_CHANNEL = "com.localbeam/player"
    private var mediaRecorder: MediaRecorder? = null
    private var recordingPath: String? = null
    private var mediaPlayer: MediaPlayer? = null
    private var playerProgressHandler: Handler? = null
    private var playerProgressRunnable: Runnable? = null

    private val RECORD_AUDIO_REQUEST_CODE = 1001
    private var pendingRecordResult: MethodChannel.Result? = null
    private var playerMethodChannel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // Downloads / MediaScanner channel
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            if (call.method == "scanFile") {
                val path = call.argument<String>("path")
                if (path != null) {
                    MediaScannerConnection.scanFile(this, arrayOf(path), null) { _, uri ->
                        // File is now visible in file managers
                    }
                    result.success(true)
                } else {
                    result.error("INVALID_PATH", "Path is null", null)
                }
            } else {
                result.notImplemented()
            }
        }

        // Voice recorder channel
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, RECORDER_CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "startRecording" -> {
                    // Check runtime permission first
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                        // Save result and request permission
                        pendingRecordResult = result
                        ActivityCompat.requestPermissions(
                            this,
                            arrayOf(Manifest.permission.RECORD_AUDIO),
                            RECORD_AUDIO_REQUEST_CODE
                        )
                    } else {
                        doStartRecording(result)
                    }
                }
                "stopRecording" -> {
                    try {
                        mediaRecorder?.apply {
                            stop()
                            release()
                        }
                        mediaRecorder = null
                        val path = recordingPath
                        recordingPath = null
                        if (path != null && File(path).exists()) {
                            result.success(path)
                        } else {
                            result.error("NO_RECORDING", "No recording file found", null)
                        }
                    } catch (e: Exception) {
                        mediaRecorder?.release()
                        mediaRecorder = null
                        result.error("STOP_ERROR", e.message, null)
                    }
                }
                "cancelRecording" -> {
                    try {
                        mediaRecorder?.apply {
                            stop()
                            release()
                        }
                    } catch (_: Exception) {
                        mediaRecorder?.release()
                    }
                    mediaRecorder = null
                    recordingPath?.let { File(it).delete() }
                    recordingPath = null
                    result.success(true)
                }
                "isRecording" -> {
                    result.success(mediaRecorder != null)
                }
                else -> result.notImplemented()
            }
        }

        // Audio player channel
        playerMethodChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, PLAYER_CHANNEL)
        playerMethodChannel!!.setMethodCallHandler { call, result ->
            when (call.method) {
                "play" -> {
                    val path = call.argument<String>("path")
                    if (path == null || !File(path).exists()) {
                        result.error("INVALID_PATH", "Audio file not found", null)
                        return@setMethodCallHandler
                    }
                    try {
                        // Stop any existing playback
                        stopPlayer()
                        mediaPlayer = MediaPlayer().apply {
                            setDataSource(path)
                            prepare()
                            start()
                            setOnCompletionListener {
                                stopProgressUpdates()
                                playerMethodChannel?.invokeMethod("onComplete", null)
                            }
                        }
                        // Start progress updates
                        startProgressUpdates()
                        result.success(mediaPlayer!!.duration)
                    } catch (e: Exception) {
                        result.error("PLAY_ERROR", e.message, null)
                    }
                }
                "pause" -> {
                    mediaPlayer?.pause()
                    stopProgressUpdates()
                    result.success(true)
                }
                "resume" -> {
                    mediaPlayer?.start()
                    startProgressUpdates()
                    result.success(true)
                }
                "stop" -> {
                    stopPlayer()
                    result.success(true)
                }
                "seekTo" -> {
                    val position = call.argument<Int>("position") ?: 0
                    mediaPlayer?.seekTo(position)
                    result.success(true)
                }
                "getPosition" -> {
                    result.success(mediaPlayer?.currentPosition ?: 0)
                }
                "getDuration" -> {
                    result.success(mediaPlayer?.duration ?: 0)
                }
                "isPlaying" -> {
                    result.success(mediaPlayer?.isPlaying ?: false)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun startProgressUpdates() {
        stopProgressUpdates()
        playerProgressHandler = Handler(Looper.getMainLooper())
        playerProgressRunnable = object : Runnable {
            override fun run() {
                mediaPlayer?.let { player ->
                    if (player.isPlaying) {
                        playerMethodChannel?.invokeMethod("onProgress", mapOf(
                            "position" to player.currentPosition,
                            "duration" to player.duration
                        ))
                        playerProgressHandler?.postDelayed(this, 200)
                    }
                }
            }
        }
        playerProgressHandler?.post(playerProgressRunnable!!)
    }

    private fun stopProgressUpdates() {
        playerProgressRunnable?.let { playerProgressHandler?.removeCallbacks(it) }
        playerProgressHandler = null
        playerProgressRunnable = null
    }

    private fun stopPlayer() {
        stopProgressUpdates()
        try {
            mediaPlayer?.apply {
                if (isPlaying) stop()
                release()
            }
        } catch (_: Exception) {}
        mediaPlayer = null
    }

    private fun doStartRecording(result: MethodChannel.Result) {
        try {
            val dir = cacheDir
            val file = File(dir, "voice_${System.currentTimeMillis()}.m4a")
            recordingPath = file.absolutePath

            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            mediaRecorder?.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(44100)
                setAudioEncodingBitRate(128000)
                setOutputFile(recordingPath)
                prepare()
                start()
            }
            result.success(recordingPath)
        } catch (e: Exception) {
            result.error("RECORD_ERROR", e.message, null)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == RECORD_AUDIO_REQUEST_CODE) {
            val result = pendingRecordResult
            pendingRecordResult = null
            if (result != null) {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    doStartRecording(result)
                } else {
                    result.error("PERMISSION_DENIED", "Microphone permission denied", null)
                }
            }
        }
    }
}
