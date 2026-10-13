
const Database = require("../backend/node_modules/better-sqlite3");
const path = require("path");

// Store the database file inside the database folder
const db = new Database(
    path.join(__dirname, "hostel-food.db")
);

// Create the food requests table if it does not exist
db.exec(`
    CREATE TABLE IF NOT EXISTS food_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        food_item TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

console.log("Hostel food database is ready!");

module.exports = db;