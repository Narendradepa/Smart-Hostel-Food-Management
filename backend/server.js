
const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("../database/db");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, "../frontend")));

app.get("/", (req, res) => {
    res.send("Smart Hostel Food Management System Backend is Running!");
});
app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        message: "Smart Hostel Food Management API is working!"
    });
});

app.get("/api/requests", (req, res) => {
    try {
        const requests = db.prepare(`
            SELECT id, food_item, quantity, notes, created_at
            FROM food_requests
            ORDER BY id DESC
        `).all();

        res.json({
            success: true,
            requests: requests
        });
    } catch (error) {
        console.error("Database error:", error);

        res.status(500).json({
            success: false,
            message: "Could not retrieve food requests."
        });
    }
});



app.post("/api/requests", (req, res) => {
    const { foodItem, quantity, notes } = req.body;

    if (!foodItem || !quantity) {
        return res.status(400).json({
            success: false,
            message: "Food item and quantity are required."
        });
    }

    try {
        const statement = db.prepare(`
            INSERT INTO food_requests (food_item, quantity, notes)
            VALUES (?, ?, ?)
        `);

        const result = statement.run(
            foodItem,
            Number(quantity),
            notes || ""
        );

        res.status(201).json({
            success: true,
            message: "Food request saved successfully!",
            request: {
                id: result.lastInsertRowid,
                foodItem,
                quantity: Number(quantity),
                notes: notes || ""
            }
        });
    } catch (error) {
        console.error("Database error:", error);

        res.status(500).json({
            success: false,
            message: "Could not save the food request."
        });
    }
});


app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
