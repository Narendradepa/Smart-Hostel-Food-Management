
const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("../database/db");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, "../frontend")));

// Home route
app.get("/", (req, res) => {
    res.send("Smart Hostel Food Management System Backend is Running!");
});

// API status route
app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        message: "Smart Hostel Food Management API is working!"
    });
});

// Retrieve all food requests
app.get("/api/requests", (req, res) => {
    try {
        const requests = db.prepare(`
            SELECT id, food_item, quantity, notes, created_at
            FROM food_requests
            ORDER BY id DESC
        `).all();

        res.json({
            success: true,
            requests
        });
    } catch (error) {
        console.error("Database retrieval error:", error);

        res.status(500).json({
            success: false,
            message: "Could not retrieve food requests."
        });
    }
});

// Submit a new food request
app.post("/api/requests", (req, res) => {
    const { foodItem, quantity, notes } = req.body;

    const cleanFoodItem =
        typeof foodItem === "string" ? foodItem.trim() : "";

    const cleanNotes =
        typeof notes === "string" ? notes.trim() : "";

    if (!cleanFoodItem) {
        return res.status(400).json({
            success: false,
            message: "Please enter a food item."
        });
    }

    if (cleanFoodItem.length > 100) {
        return res.status(400).json({
            success: false,
            message: "Food item must not exceed 100 characters."
        });
    }

    if (
        quantity === undefined ||
        quantity === null ||
        quantity === "" ||
        !Number.isInteger(Number(quantity)) ||
        Number(quantity) < 1 ||
        Number(quantity) > 100
    ) {
        return res.status(400).json({
            success: false,
            message: "Quantity must be a whole number between 1 and 100."
        });
    }

    if (cleanNotes.length > 500) {
        return res.status(400).json({
            success: false,
            message: "Notes must not exceed 500 characters."
        });
    }

    const numericQuantity = Number(quantity);

    try {
        const statement = db.prepare(`
            INSERT INTO food_requests (food_item, quantity, notes)
            VALUES (?, ?, ?)
        `);

        const result = statement.run(
            cleanFoodItem,
            numericQuantity,
            cleanNotes
        );

        return res.status(201).json({
            success: true,
            message: "Food request saved successfully!",
            request: {
                id: result.lastInsertRowid,
                foodItem: cleanFoodItem,
                quantity: numericQuantity,
                notes: cleanNotes
            }
        });
    } catch (error) {
        console.error("Database insertion error:", error);

        return res.status(500).json({
            success: false,
            message: "Could not save the food request."
        });
    }
});

// Start the server
// Start the server only when this file is run directly.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
}

// Export the app for automated tests.
module.exports = app;
