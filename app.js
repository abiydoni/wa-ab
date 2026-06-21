module.exports = {
  apps: [{
    name: "wa-ab-gateway",
    script: "./server.js",
    watch: false,
    ignore_watch: ["node_modules", "sessions", "tmp", "logs", "*.log"],
    env: {
      NODE_ENV: "production",
      PORT: 3456,
      TZ: "Asia/Jakarta" // Menyesuaikan dengan zona waktu di server.js
    },
    // Restart otomatis jika memori melebihi 500MB untuk menghindari crash
    max_memory_restart: "500M",
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    merge_logs: true,
    time: true
  }]
};
