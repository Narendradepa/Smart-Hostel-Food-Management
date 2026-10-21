const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("../database/db");

const app = express();
const PORT = process.env.PORT || 3000;
const STUDENT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use(express.static(path.join(__dirname, "../frontend")));

app.get("/api/status", (req, res) => {
    res.json({ success: true, message: "Smart Hostel Food Management API is working!" });
});

function studentIdFrom(value) {
    if (typeof value === "string" && STUDENT_ID_PATTERN.test(value)) return value;
    return "";
}

function cleanText(value, limit, required = false) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if ((required && !text) || text.length > limit) return null;
    return text;
}

function addNotification(studentId, message) {
    db.prepare("INSERT INTO notifications (student_id, message) VALUES (?, ?)")
        .run(studentId || null, message);
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

function fail(res, status, message) {
    return res.status(status).json({ success: false, message });
}

function ensureTodayMenu() {
    const exists = db.prepare("SELECT 1 FROM menus WHERE menu_date = ?").get(today());
    if (exists) return;
    const previous = db.prepare("SELECT breakfast, lunch, dinner FROM menus ORDER BY menu_date DESC LIMIT 1").get();
    if (previous) {
        db.prepare("INSERT OR IGNORE INTO menus (menu_date, breakfast, lunch, dinner) VALUES (?, ?, ?, ?)")
            .run(today(), previous.breakfast, previous.lunch, previous.dinner);
    }
}

app.get("/api/menu", (req, res) => {
    ensureTodayMenu();
    const menu = db.prepare(`
        SELECT menu_date, breakfast, lunch, dinner, updated_at
        FROM menus WHERE menu_date = ?
    `).get(today());
    res.json({ success: true, menu });
});

// This exact endpoint is protected by the EC2 Nginx Basic Auth rule. All
// administration reads and writes use it so student submissions stay public.
app.get("/api/requests", (req, res) => {
    const view = req.query.view || "requests";
    const reports = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM food_requests) AS total_requests,
            (SELECT COUNT(*) FROM food_requests WHERE status = 'pending') AS pending_requests,
            (SELECT COUNT(*) FROM feedback) AS total_feedback,
            (SELECT COUNT(*) FROM complaints) AS total_complaints,
            (SELECT COUNT(*) FROM complaints WHERE status != 'resolved') AS open_complaints,
            (SELECT COUNT(*) FROM staff_ratings) AS total_ratings,
            (SELECT ROUND(AVG(rating), 1) FROM staff_ratings) AS average_rating
    `).get();

    if (view === "summary" || view === "reports") {
        return res.json({ success: true, reports });
    }
    if (view === "feedback") {
        return res.json({
            success: true,
            feedback: db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 200").all()
        });
    }
    if (view === "complaints") {
        return res.json({
            success: true,
            complaints: db.prepare("SELECT * FROM complaints ORDER BY id DESC LIMIT 200").all()
        });
    }
    if (view === "ratings") {
        return res.json({
            success: true,
            ratings: db.prepare("SELECT * FROM staff_ratings ORDER BY id DESC LIMIT 200").all(),
            reports
        });
    }

    const requests = db.prepare(`
        SELECT id, food_item, quantity, notes, student_id, status, created_at
        FROM food_requests ORDER BY id DESC LIMIT 200
    `).all();
    return res.json({ success: true, requests });
});

app.put("/api/requests", (req, res) => {
    const { action } = req.body || {};

    if (action === "update-menu") {
        const breakfast = cleanText(req.body.breakfast, 300, true);
        const lunch = cleanText(req.body.lunch, 300, true);
        const dinner = cleanText(req.body.dinner, 300, true);
        if (breakfast === null || lunch === null || dinner === null) {
            return fail(res, 400, "Enter all three meals (up to 300 characters each).");
        }
        db.prepare(`
            INSERT INTO menus (menu_date, breakfast, lunch, dinner, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(menu_date) DO UPDATE SET
                breakfast = excluded.breakfast,
                lunch = excluded.lunch,
                dinner = excluded.dinner,
                updated_at = CURRENT_TIMESTAMP
        `).run(today(), breakfast, lunch, dinner);
        addNotification(null, "Today's food menu was updated.");
        return res.json({ success: true, message: "Today's menu was updated." });
    }

    if (action === "update-request") {
        const id = Number(req.body.id);
        const status = req.body.status;
        const validStatuses = ["pending", "approved", "preparing", "completed", "rejected"];
        if (!Number.isInteger(id) || !validStatuses.includes(status)) {
            return fail(res, 400, "Choose a valid request and status.");
        }
        const request = db.prepare("SELECT student_id FROM food_requests WHERE id = ?").get(id);
        if (!request) return fail(res, 404, "Food request was not found.");
        db.prepare("UPDATE food_requests SET status = ? WHERE id = ?").run(status, id);
        if (request.student_id) addNotification(request.student_id, `Food request #${id} is now ${status}.`);
        return res.json({ success: true, message: `Request #${id} updated to ${status}.` });
    }

    if (action === "acknowledge-feedback") {
        const id = Number(req.body.id);
        const result = db.prepare("UPDATE feedback SET status = 'acknowledged' WHERE id = ?").run(id);
        if (!result.changes) return fail(res, 404, "Feedback was not found.");
        return res.json({ success: true, message: "Feedback acknowledged." });
    }

    if (action === "update-complaint") {
        const id = Number(req.body.id);
        const status = req.body.status;
        if (!Number.isInteger(id) || !["open", "in_review", "resolved"].includes(status)) {
            return fail(res, 400, "Choose a valid complaint and status.");
        }
        const complaint = db.prepare("SELECT student_id FROM complaints WHERE id = ?").get(id);
        if (!complaint) return fail(res, 404, "Complaint was not found.");
        db.prepare("UPDATE complaints SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(status, id);
        if (complaint.student_id) addNotification(complaint.student_id, `Your complaint #${id} is now ${status.replace("_", " ")}.`);
        return res.json({ success: true, message: `Complaint #${id} updated.` });
    }

    return fail(res, 400, "Unknown administration action.");
});

function submitFoodRequest(req, res) {
    const foodItem = cleanText(req.body.foodItem, 100, true);
    const notes = cleanText(req.body.notes || "", 500);
    const quantity = Number(req.body.quantity);
    if (foodItem === null || !foodItem) return fail(res, 400, "Enter a food item (up to 100 characters).");
    if (notes === null) return fail(res, 400, "Notes must not exceed 500 characters.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return fail(res, 400, "Quantity must be a whole number between 1 and 100.");
    }
    const studentId = studentIdFrom(req.body.studentId);
    try {
        const result = db.prepare(`
            INSERT INTO food_requests (food_item, quantity, notes, student_id)
            VALUES (?, ?, ?, ?)
        `).run(foodItem, quantity, notes, studentId);
        if (studentId) addNotification(studentId, `Food request #${result.lastInsertRowid} was received.`);
        return res.status(201).json({
            success: true,
            message: "Food request received.",
            request: { id: result.lastInsertRowid, foodItem, quantity, notes, status: "pending" }
        });
    } catch (error) {
        console.error("Food request save failed:", error);
        return fail(res, 500, "Could not save the food request.");
    }
}

app.post("/api/requests", submitFoodRequest);
app.post("/api/requests/submit", submitFoodRequest);

app.get("/api/preferences/:studentId", (req, res) => {
    const studentId = studentIdFrom(req.params.studentId);
    if (!studentId) return fail(res, 400, "Invalid student session.");
    const preferences = db.prepare(`
        SELECT diet, less_spicy, updated_at FROM food_preferences WHERE student_id = ?
    `).get(studentId) || { diet: "vegetarian", less_spicy: 0 };
    res.json({ success: true, preferences });
});

app.post("/api/preferences", (req, res) => {
    const studentId = studentIdFrom(req.body.studentId);
    const { diet, lessSpicy } = req.body;
    if (!studentId || !["vegetarian", "non_vegetarian"].includes(diet) || typeof lessSpicy !== "boolean") {
        return fail(res, 400, "Choose a diet and spice preference.");
    }
    db.prepare(`
        INSERT INTO food_preferences (student_id, diet, less_spicy, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(student_id) DO UPDATE SET
            diet = excluded.diet, less_spicy = excluded.less_spicy, updated_at = CURRENT_TIMESTAMP
    `).run(studentId, diet, Number(lessSpicy));
    addNotification(studentId, "Your food preferences were saved.");
    res.json({ success: true, message: "Food preferences saved." });
});

function submitTextRecord(table, label) {
    return (req, res) => {
        const studentId = studentIdFrom(req.body.studentId);
        const message = cleanText(req.body.message, 2000, true);
        if (!studentId) return fail(res, 400, "Refresh this page to start a student session.");
        if (message === null || !message) return fail(res, 400, `Enter ${label.toLowerCase()} (up to 2,000 characters).`);
        const result = db.prepare(`INSERT INTO ${table} (student_id, message) VALUES (?, ?)`)
            .run(studentId, message);
        addNotification(studentId, `${label} #${result.lastInsertRowid} was received.`);
        return res.status(201).json({ success: true, message: `${label} received.` });
    };
}

app.post("/api/feedback/submit", submitTextRecord("feedback", "Feedback"));
app.post("/api/complaints/submit", submitTextRecord("complaints", "Complaint"));

app.post("/api/ratings/submit", (req, res) => {
    const studentId = studentIdFrom(req.body.studentId);
    const rating = Number(req.body.rating);
    const comment = cleanText(req.body.comment || "", 500);
    if (!studentId || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment === null) {
        return fail(res, 400, "Select a rating from 1 to 5 and keep comments under 500 characters.");
    }
    db.prepare("INSERT INTO staff_ratings (student_id, rating, comment) VALUES (?, ?, ?)")
        .run(studentId, rating, comment);
    addNotification(studentId, "Your staff rating was submitted.");
    res.status(201).json({ success: true, message: "Staff rating submitted." });
});

app.get("/api/notifications/:studentId", (req, res) => {
    const studentId = studentIdFrom(req.params.studentId);
    if (!studentId) return fail(res, 400, "Invalid student session.");
    const notifications = db.prepare(`
        SELECT id, message, created_at FROM notifications
        WHERE student_id = ? OR student_id IS NULL
        ORDER BY id DESC LIMIT 50
    `).all(studentId);
    res.json({ success: true, notifications });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

if (require.main === module) {
    app.listen(PORT, "127.0.0.1", () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
}

module.exports = app;
