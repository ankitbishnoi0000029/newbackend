// lib/authUtils.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'game',
  connectionLimit: 10,
  queueLimit: 0
};

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
const JWT_EXPIRES_IN = '12h';

// Generate JWT token
function generateToken(user) {
  const payload = {
    username: user.username
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// Verify JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Hash password
async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

// Verify password
async function verifyPassword(password, hashedPassword) {
  return bcrypt.compare(password, hashedPassword);
}

// Login user
async function login(username, password) {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // Find user by username
      const [rows] = await connection.execute(
        'SELECT * FROM users WHERE username = ? AND password = ?',
        [username, password]
      );


      if (rows.length === 0) {
        return { success: false, error: 'User not found or inactive' };
      }

      const user = rows[0];
      // Generate token
      const token = generateToken(user);
      await connection.execute(
        'UPDATE users SET token = ? WHERE username = ?',
        [token, user.username]
      );
      return {
        success: true,
        token: token,
        user: user.username
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Login error:', error);
    return { success: false, error: error.message || 'Internal server error' };
  }
}


// Verify token from database and JWT
async function verifyTokenFromDB(token) {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // First verify JWT token
      const decoded = verifyToken(token);
      if (!decoded) {
        return { success: false, error: 'Invalid or expired token' };
      }

      // Check if token exists in users table and is not expired
      const [rows] = await connection.execute(
        `SELECT id, user_id 
         FROM users
         WHERE token = ?`,
        [token]
      );

      if (rows.length === 0) {
        return { success: false, error: 'Token not found or expired' };
      }

      const userData = rows[0];

      return {
        success: true,
        valid: true,
        user: {
          id: userData.id,
          username: userData.user_id,
          token: userData.token
        }
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Verify token error:', error);
    return { success: false, error: error.message || 'Internal server error' };
  }
}




export {
  JWT_SECRET,
  generateToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  login,
  verifyTokenFromDB,
};