import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import cors from "cors";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  let ffmpegProcess = null;
  let chunkBuffer = [];
  let isFfmpegReady = false;

  socket.on("start-stream", ({ rtmpUrl, key }) => {
    const streamUrl = `${rtmpUrl}/${key}`;
    console.log(`Starting stream to: ${rtmpUrl} (hidden key)`);

    chunkBuffer = []; // Reset buffer
    isFfmpegReady = false;

    // Input options for receiving raw WebM from browser
    ffmpegProcess = ffmpeg({ source: "pipe:0" })
      .inputOptions([
        // '-re', // Do NOT use -re for live pipes
        "-analyzeduration 100000", // Reduce analysis time
        "-probesize 100000",
      ])
      .outputOptions([
        "-c:v libx264", // H.264 video codec
        "-preset ultrafast", // Low latency (crucial for Render free tier)
        "-tune zerolatency",
        "-maxrate 2500k",
        "-bufsize 5000k",
        "-pix_fmt yuv420p",
        "-g 60", // Keyframe interval (approx 2s at 30fps)
        "-c:a aac", // AAC audio codec
        "-ar 44100",
        "-b:a 128k",
        "-f flv", // FLV format for RTMP
      ])
      .output(streamUrl)
      .on("start", (commandLine) => {
        console.log("FFmpeg process started:", commandLine);
        socket.emit("stream-status", "started");
        isFfmpegReady = true;

        // --- CRITICAL FIX: Prevent EPIPE Crash ---
        // If FFmpeg quits while we are writing to it, this catches the error.
        if (ffmpegProcess.ffmpegProc && ffmpegProcess.ffmpegProc.stdin) {
          ffmpegProcess.ffmpegProc.stdin.on("error", (err) => {
            console.log(
              "FFmpeg STDIN Error (usually benign if stream stopped):",
              err.message
            );
          });
        }

        // Flush buffer
        if (chunkBuffer.length > 0) {
          console.log(`Flushing ${chunkBuffer.length} buffered chunks`);
          chunkBuffer.forEach((data) => {
            if (ffmpegProcess && ffmpegProcess.ffmpegProc) {
              try {
                ffmpegProcess.ffmpegProc.stdin.write(data);
              } catch (e) {
                console.error("Write error during flush", e);
              }
            }
          });
          chunkBuffer = [];
        }
      })
      .on("error", (err, stdout, stderr) => {
        console.error("FFmpeg error:", err.message);
        // Only log stderr if it exists and isn't just a kill signal
        if (stderr && !err.message.includes("SIGKILL")) {
          console.error("FFmpeg stderr:", stderr);
        }
        socket.emit("stream-status", `error: ${err.message}`);
      })
      .on("end", () => {
        console.log("FFmpeg process ended");
        socket.emit("stream-status", "ended");
      });

    // Start the process
    ffmpegProcess.run();
  });

  socket.on("binary-stream", (data) => {
    if (
      isFfmpegReady &&
      ffmpegProcess &&
      ffmpegProcess.ffmpegProc &&
      !ffmpegProcess.ffmpegProc.stdin.destroyed
    ) {
      try {
        ffmpegProcess.ffmpegProc.stdin.write(data);
      } catch (err) {
        // This catch block handles synchronous write errors
        console.error("Error writing to ffmpeg stdin:", err.message);
      }
    } else if (ffmpegProcess) {
      // Buffer if stream is requested but not ready
      console.log("Buffering chunk, ffmpeg not ready");
      chunkBuffer.push(data);
    }
  });

  socket.on("stop-stream", () => {
    if (ffmpegProcess) {
      console.log("Stopping stream manually");
      ffmpegProcess.kill("SIGKILL");
      ffmpegProcess = null;
      socket.emit("stream-status", "stopped");
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    if (ffmpegProcess) {
      ffmpegProcess.kill("SIGKILL");
      ffmpegProcess = null;
    }
  });
});

// Use Render's PORT or fallback to 3000 locally
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Streaming Server running on port ${PORT}`);
});
