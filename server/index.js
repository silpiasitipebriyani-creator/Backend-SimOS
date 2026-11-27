require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const app = express();

// Middleware CORS & JSON Parser (cukup sekali saja)
app.use(
  cors({
    origin: "*", // Nanti bisa diarahkan ke URL frontend SimOS
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);
app.use(express.json());

// Koneksi Pool MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Aktifkan SSL jika database cloud (seperti TiDB Cloud / Aiven) mensyaratkannya:
  // ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

async function getUserIdByUsername(username) {
  if (!username) return null;
  const [rows] = await pool.query("SELECT id FROM users WHERE username = ?", [
    username,
  ]);
  return rows.length > 0 ? rows[0].id : null;
}

// Endpoint pengecekan status server
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "Backend SimOS berjalan dengan baik!",
  });
});

// ==================== AUTH ====================

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (username, password) VALUES (?, ?)", [
      username,
      hashedPassword,
    ]);
    res.status(201).json({ message: "Registrasi berhasil" });
  } catch (error) {
    console.error("Error register:", error);
    if (error.code === "ER_DUP_ENTRY") {
      res.status(400).json({ error: "Username sudah digunakan" });
    } else {
      res.status(500).json({
        error: "Gagal melakukan registrasi",
        code: error.code || null,
        detail: error.sqlMessage || error.message || null,
      });
    }
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [
      username,
    ]);

    if (rows.length === 0) {
      return res.status(401).json({ error: "Username tidak ditemukan" });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(401).json({ error: "Password salah" });
    }

    res.json({
      message: "Login berhasil",
      userId: user.id,
      username: user.username,
    });
  } catch (error) {
    res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
});

// ==================== RIWAYAT USER (GET SEMUA) ====================

app.get("/api/history/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const userId = await getUserIdByUsername(username);
    if (!userId) {
      return res.status(404).json({ error: "User tidak ditemukan" });
    }

    const [quizRows] = await pool.query(
      `SELECT id, module, difficulty, score, correct, wrong, total, final_score, date
       FROM quiz_history
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    const [simRows] = await pool.query(
      `SELECT id, type, algorithm, summary, is_safe_optimal, date
       FROM simulator_history
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    const quizHistory = quizRows.map((row) => ({
      id: row.id,
      module: row.module,
      difficulty: row.difficulty,
      score: row.score,
      correct: row.correct,
      wrong: row.wrong,
      total: row.total,
      finalScore: row.final_score,
      date: row.date,
    }));

    const simulatorHistory = simRows.map((row) => ({
      id: row.id,
      type: row.type,
      algorithm: row.algorithm,
      summary: row.summary,
      isSafeOrOptimal: Boolean(row.is_safe_optimal),
      date: row.date,
    }));

    res.json({ quizHistory, simulatorHistory });
  } catch (error) {
    console.error("Error GET /api/history:", error);
    res.status(500).json({ error: "Gagal mengambil riwayat pengguna" });
  }
});

// ==================== QUIZ HISTORY ====================

app.post("/api/quiz-history", async (req, res) => {
  const {
    username,
    id,
    module,
    difficulty,
    score,
    correct,
    wrong,
    total,
    finalScore,
    date,
  } = req.body;

  try {
    const userId = await getUserIdByUsername(username);
    if (!userId) {
      return res.status(404).json({ error: "User tidak ditemukan" });
    }

    const recordId = id || crypto.randomUUID();
    const safeCorrect = correct ?? score ?? 0;
    const safeTotal = total ?? 0;
    const safeWrong = wrong ?? Math.max(0, safeTotal - safeCorrect);
    const safeFinalScore =
      finalScore ??
      (safeTotal > 0 ? Math.round((safeCorrect / safeTotal) * 100) : 0);

    await pool.query(
      `INSERT INTO quiz_history
       (id, user_id, module, difficulty, score, correct, wrong, total, final_score, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recordId,
        userId,
        module,
        difficulty || "Sedang",
        score ?? safeCorrect,
        safeCorrect,
        safeWrong,
        safeTotal,
        safeFinalScore,
        date,
      ]
    );

    res.status(201).json({
      message: "Riwayat kuis berhasil disimpan",
      item: {
        id: recordId,
        module,
        difficulty: difficulty || "Sedang",
        score: score ?? safeCorrect,
        correct: safeCorrect,
        wrong: safeWrong,
        total: safeTotal,
        finalScore: safeFinalScore,
        date,
      },
    });
  } catch (error) {
    console.error("Error POST /api/quiz-history:", error);
    res.status(500).json({ error: "Gagal menyimpan riwayat kuis" });
  }
});

app.delete("/api/quiz-history/user/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const userId = await getUserIdByUsername(username);
    if (!userId) {
      return res.status(404).json({ error: "User tidak ditemukan" });
    }

    await pool.query("DELETE FROM quiz_history WHERE user_id = ?", [userId]);
    res.json({ message: "Semua riwayat kuis berhasil dihapus" });
  } catch (error) {
    console.error("Error DELETE all quiz-history:", error);
    res.status(500).json({ error: "Gagal menghapus semua riwayat kuis" });
  }
});

app.delete("/api/quiz-history/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM quiz_history WHERE id = ?", [id]);
    res.json({ message: "Riwayat kuis berhasil dihapus" });
  } catch (error) {
    console.error("Error DELETE /api/quiz-history/:id:", error);
    res.status(500).json({ error: "Gagal menghapus riwayat kuis" });
  }
});

// ==================== SIMULATOR HISTORY ====================

app.post("/api/simulator-history", async (req, res) => {
  const { username, id, type, algorithm, summary, isSafeOrOptimal, date } =
    req.body;

  try {
    const userId = await getUserIdByUsername(username);
    if (!userId) {
      return res.status(404).json({ error: "User tidak ditemukan" });
    }

    const recordId = id || crypto.randomUUID();
    const safeFlag = Boolean(isSafeOrOptimal);

    await pool.query(
      `INSERT INTO simulator_history
       (id, user_id, type, algorithm, summary, is_safe_optimal, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [recordId, userId, type, algorithm, summary, safeFlag ? 1 : 0, date]
    );

    res.status(201).json({
      message: "Riwayat simulasi berhasil disimpan",
      item: {
        id: recordId,
        type,
        algorithm,
        summary,
        isSafeOrOptimal: safeFlag,
        date,
      },
    });
  } catch (error) {
    console.error("Error POST /api/simulator-history:", error);
    res.status(500).json({ error: "Gagal menyimpan riwayat simulasi" });
  }
});

app.delete("/api/simulator-history/user/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const userId = await getUserIdByUsername(username);
    if (!userId) {
      return res.status(404).json({ error: "User tidak ditemukan" });
    }

    await pool.query("DELETE FROM simulator_history WHERE user_id = ?", [
      userId,
    ]);
    res.json({ message: "Semua riwayat simulasi berhasil dihapus" });
  } catch (error) {
    console.error("Error DELETE all simulator-history:", error);
    res.status(500).json({ error: "Gagal menghapus semua riwayat simulasi" });
  }
});

app.delete("/api/simulator-history/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM simulator_history WHERE id = ?", [id]);
    res.json({ message: "Riwayat simulasi berhasil dihapus" });
  } catch (error) {
    console.error("Error DELETE /api/simulator-history/:id:", error);
    res.status(500).json({ error: "Gagal menghapus riwayat simulasi" });
  }
});

// Jalankan listen jika bukan di environment Vercel serverless
const PORT = process.env.PORT || 3001;
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server API berjalan di port ${PORT}`);
  });
}

module.exports = app;