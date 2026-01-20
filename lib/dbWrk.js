// Database work functions for the game server
// MySQL database operations

import 'dotenv/config';
import mysql from 'mysql2/promise';

// Database connection configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'game',
  connectionLimit: 10,
  queueLimit: 0,
  waitForConnections: true
};

// Create connection pool
let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}



export async function saveGameRound(roundData) {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // Insert into game_rounds table (assuming it exists)
      const [result] = await connection.execute(
        `INSERT INTO game_rounds (
          round_number, round_start_time, round_end_time,
          a1_result, a2_result, b1_result, b2_result, c1_result, c2_result,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          roundData.roundNumber,
          roundData.roundStartTime,
          roundData.roundEndTime,
          roundData.a1, roundData.a2, roundData.b1, roundData.b2, roundData.c1, roundData.c2,
          roundData.status || 'active'
        ]
      );

      const roundId = result.insertId;

      return {
        success: true,
        roundId: roundId,
        message: 'Round saved successfully'
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error saving game round:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

export async function updateGameRound(roundId, updateData) {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // Build dynamic update query
      const updateFields = [];
      const values = [];

      if (updateData.a1 !== undefined) {
        updateFields.push('a1_result = ?');
        values.push(updateData.a1);
      }
      if (updateData.a2 !== undefined) {
        updateFields.push('a2_result = ?');
        values.push(updateData.a2);
      }
      if (updateData.b1 !== undefined) {
        updateFields.push('b1_result = ?');
        values.push(updateData.b1);
      }
      if (updateData.b2 !== undefined) {
        updateFields.push('b2_result = ?');
        values.push(updateData.b2);
      }
      if (updateData.c1 !== undefined) {
        updateFields.push('c1_result = ?');
        values.push(updateData.c1);
      }
      if (updateData.c2 !== undefined) {
        updateFields.push('c2_result = ?');
        values.push(updateData.c2);
      }
      if (updateData.status !== undefined) {
        updateFields.push('status = ?');
        values.push(updateData.status);
      }

      if (updateFields.length === 0) {
        return {
          success: false,
          error: 'No valid fields to update'
        };
      }

      updateFields.push('updated_at = NOW()');
      values.push(roundId);

      const query = `UPDATE game_rounds SET ${updateFields.join(', ')} WHERE id = ?`;
      const [result] = await connection.execute(query, values);

      if (result.affectedRows === 0) {
        return {
          success: false,
          error: 'Round not found'
        };
      }

      return {
        success: true,
        message: 'Round updated successfully'
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating game round:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
export async function getHistory() {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // Get all game history records, ordered by most recent first
      const [rows] = await connection.execute(
        `SELECT * FROM game_history ORDER BY id DESC`
      );

      // Format the data for frontend
      const formattedData = rows.map(row => ({
        id: row.id,
        time: row.round_start_time || row.created_at,
        a1: row.a1,
        a2: row.a2,
        b1: row.b1,
        b2: row.b2,
        c1: row.c1,
        c2: row.c2,
        createdAt: row.created_at
      }));

      return {
        success: true,
        data: formattedData
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error getting game history:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
export async function getCurrentGameRound() {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // Get the most recent active round
      const [rows] = await connection.execute(
        `SELECT * FROM game_rounds
         WHERE status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`
      );

      if (rows.length > 0) {
        const round = rows[0];
        return {
          success: true,
          round: {
            id: round.id,
            roundNumber: round.round_number,
            roundStartTime: round.round_start_time,
            roundEndTime: round.round_end_time,
            a1: round.a1_result,
            a2: round.a2_result,
            b1: round.b1_result,
            b2: round.b2_result,
            c1: round.c1_result,
            c2: round.c2_result,
            status: round.status,
            createdAt: round.created_at,
            updatedAt: round.updated_at
          }
        };
      }

      return {
        success: true,
        round: null,
        message: 'No active round found'
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error getting current game round:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

export async function insertHistory(historyData) {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // Insert into game.game_history table
      const [result] = await connection.execute(
        `INSERT INTO game_history (
          round_start_time, a1, a2, b1, b2, c1, c2, created_at,roundId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(),?)`,
        [
          historyData.roundStartTime || new Date().toISOString(),
          historyData.a1,
          historyData.a2,
          historyData.b1,
          historyData.b2,
          historyData.c1,
          historyData.c2,
          historyData.roundId
        ]
      );

      return {
        success: true,
        message: 'History entry inserted successfully',
        insertId: result.insertId
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error inserting history:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Helper functions for debugging/testing - now use database
export async function getAllRounds() {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      const [rows] = await connection.execute(
        'SELECT * FROM game_rounds ORDER BY created_at DESC'
      );
      return rows;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error getting all rounds:', error);
    return [];
  }
}

export async function getAllHistory() {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      const [rows] = await connection.execute(
        'SELECT * FROM game_history ORDER BY created_at DESC'
      );
      return rows;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error getting all history:', error);
    return [];
  }
}

export async function clearData() {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.execute('DELETE FROM game_history');
      await connection.execute('DELETE FROM game_rounds');
      return { success: true, message: 'All data cleared' };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error clearing data:', error);
    return { success: false, error: error.message };
  }
}
