// Test script for MySQL database connection and operations
import mysql from 'mysql2/promise';
import 'dotenv/config';

async function testDatabase() {
  console.log('🧪 Testing database connection...');

  // Create direct connection to check table structure
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    console.log('✅ Database connection successful!');

    // Check table structure
    console.log('\n📋 Checking game_history table structure...');
    const [columns] = await connection.execute('DESCRIBE game_history');
    console.log('Table columns:');
    columns.forEach(col => {
      console.log(`  - ${col.Field}: ${col.Type} ${col.Null === 'YES' ? '(NULL)' : '(NOT NULL)'} ${col.Key ? `(${col.Key})` : ''}`);
    });

    // Check if table exists and has data
    console.log('\n📊 Checking existing data...');
    const [rows] = await connection.execute('SELECT COUNT(*) as count FROM game_history');
    console.log(`Total records in game_history: ${rows[0].count}`);

    // Show sample data if exists
    if (rows[0].count > 0) {
      const [sample] = await connection.execute('SELECT * FROM game_history LIMIT 3');
      console.log('Sample records:', sample);
    }

    // Now test the insertHistory function
    console.log('\n📝 Testing history insertion...');
    const testData = {
      a1: 5,
      a2: 3,
      b1: 7,
      b2: 2,
      c1: 9,
      c2: 1,
      timestamp: new Date()
    };

    // Import the function after checking table structure
    const { insertHistory } = await import('./lib/dbWrk.js');
    const insertResult = await insertHistory(testData);
    console.log('Insert result:', insertResult);

    if (insertResult.success) {
      console.log('✅ History insertion successful!');
    } else {
      console.error('❌ History insertion failed:', insertResult.error);
    }

  } finally {
    await connection.end();
  }
}

testDatabase().catch(console.error);
