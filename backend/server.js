const express = require("express");
const path = require("path");
const storage = require("./storage");

const app = express();
const PORT = process.env.PORT || 3000;
const STUDENT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use((req, res, next) => {
    req.body = req.body || {};
    next();
});
app.use(express.static(path.join(__dirname, "../frontend")));

app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        message: "Smart Hostel Food Management API is working!",
        storage: storage.provider
    });
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

async function addNotification(studentId, message) {
    return storage.insert("notifications", {
        student_id: studentId || null,
        message
    });
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

function fail(res, status, message) {
    return res.status(status).json({ success: false, message });
}

app.get("/api/menu", async (req, res) => {
    const menu = await storage.getMenu(today());
    res.json({ success: true, menu });
});

// The /api/requests admin reads and writes are protected by the EC2 Nginx
// Basic Auth rule. Student submissions use the dedicated public POST routes.
app.get("/api/requests", async (req, res) => {
    const view = req.query.view || "requests";
    const reports = await storage.getReports();

    if (view === "summary" || view === "reports") {
        return res.json({ success: true, reports });
    }
    if (view === "feedback") {
        return res.json({ success: true, feedback: await storage.list("feedback") });
    }
    if (view === "complaints") {
        return res.json({ success: true, complaints: await storage.list("complaints") });
    }
    if (view === "ratings") {
        return res.json({
            success: true,
            ratings: await storage.list("staff_ratings"),
            reports
        });
    }
    return res.json({ success: true, requests: await storage.list("food_requests") });
});

app.put("/api/requests", async (req, res) => {
    const { action } = req.body || {};

    if (action === "update-menu") {
        const breakfast = cleanText(req.body.breakfast, 300, true);
        const lunch = cleanText(req.body.lunch, 300, true);
        const dinner = cleanText(req.body.dinner, 300, true);
        if (breakfast === null || lunch === null || dinner === null) {
            return fail(res, 400, "Enter all three meals (up to 300 characters each).");
        }
        await storage.saveMenu(today(), { breakfast, lunch, dinner });
        await addNotification(null, "Today's food menu was updated.");
        return res.json({ success: true, message: "Today's menu was updated." });
    }

    if (action === "update-request") {
        const id = Number(req.body.id);
        const status = req.body.status;
        const validStatuses = ["pending", "approved", "preparing", "completed", "rejected"];
        if (!Number.isInteger(id) || id < 1 || !validStatuses.includes(status)) {
            return fail(res, 400, "Choose a valid request and status.");
        }
        const request = await storage.get("food_requests", id);
        if (!request) return fail(res, 404, "Food request was not found.");
        await storage.update("food_requests", id, { status });
        if (request.student_id) await addNotification(request.student_id, `Food request #${id} is now ${status}.`);
        return res.json({ success: true, message: `Request #${id} updated to ${status}.` });
    }

    if (action === "acknowledge-feedback") {
        const id = Number(req.body.id);
        if (!Number.isInteger(id) || id < 1) return fail(res, 400, "Choose valid feedback.");
        const updated = await storage.update("feedback", id, { status: "acknowledged" });
        if (!updated) return fail(res, 404, "Feedback was not found.");
        return res.json({ success: true, message: "Feedback acknowledged." });
    }

    if (action === "update-complaint") {
        const id = Number(req.body.id);
        const status = req.body.status;
        if (!Number.isInteger(id) || id < 1 || !["open", "in_review", "resolved"].includes(status)) {
            return fail(res, 400, "Choose a valid complaint and status.");
        }
        const complaint = await storage.get("complaints", id);
        if (!complaint) return fail(res, 404, "Complaint was not found.");
        await storage.update("complaints", id, { status, updated_at: new Date().toISOString() });
        if (complaint.student_id) {
            await addNotification(complaint.student_id, `Your complaint #${id} is now ${status.replace("_", " ")}.`);
        }
        return res.json({ success: true, message: `Complaint #${id} updated.` });
    }

    return fail(res, 400, "Unknown administration action.");
});

async function submitFoodRequest(req, res) {
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
        const request = await storage.insert("food_requests", {
            food_item: foodItem,
            quantity,
            notes,
            student_id: studentId
        });
        if (studentId) await addNotification(studentId, `Food request #${request.id} was received.`);
        return res.status(201).json({
            success: true,
            message: "Food request received.",
            request: { id: request.id, foodItem, quantity, notes, status: "pending" }
        });
    } catch (error) {
        console.error("Food request save failed:", error);
        return fail(res, 500, "Could not save the food request.");
    }
}

app.post("/api/requests", submitFoodRequest);
app.post("/api/requests/submit", submitFoodRequest);

app.get("/api/preferences/:studentId", async (req, res) => {
    const studentId = studentIdFrom(req.params.studentId);
    if (!studentId) return fail(res, 400, "Invalid student session.");
    const preferences = await storage.getPreference(studentId);
    res.json({ success: true, preferences });
});

app.post("/api/preferences", async (req, res) => {
    const studentId = studentIdFrom(req.body.studentId);
    const { diet, lessSpicy } = req.body;
    if (!studentId || !["vegetarian", "non_vegetarian"].includes(diet) || typeof lessSpicy !== "boolean") {
        return fail(res, 400, "Choose a diet and spice preference.");
    }
    await storage.savePreference(studentId, diet, lessSpicy);
    await addNotification(studentId, "Your food preferences were saved.");
    res.json({ success: true, message: "Food preferences saved." });
});

function submitTextRecord(entity, label) {
    return async (req, res) => {
        const studentId = studentIdFrom(req.body.studentId);
        const message = cleanText(req.body.message, 2000, true);
        if (!studentId) return fail(res, 400, "Refresh this page to start a student session.");
        if (message === null || !message) return fail(res, 400, `Enter ${label.toLowerCase()} (up to 2,000 characters).`);
        const record = await storage.insert(entity, { student_id: studentId, message });
        await addNotification(studentId, `${label} #${record.id} was received.`);
        return res.status(201).json({ success: true, message: `${label} received.` });
    };
}

app.post("/api/feedback/submit", submitTextRecord("feedback", "Feedback"));
app.post("/api/complaints/submit", submitTextRecord("complaints", "Complaint"));

app.post("/api/ratings/submit", async (req, res) => {
    const studentId = studentIdFrom(req.body.studentId);
    const rating = Number(req.body.rating);
    const comment = cleanText(req.body.comment || "", 500);
    if (!studentId || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment === null) {
        return fail(res, 400, "Select a rating from 1 to 5 and keep comments under 500 characters.");
    }
    await storage.insert("staff_ratings", { student_id: studentId, rating, comment });
    await addNotification(studentId, "Your staff rating was submitted.");
    res.status(201).json({ success: true, message: "Staff rating submitted." });
});

app.get("/api/notifications/:studentId", async (req, res) => {
    const studentId = studentIdFrom(req.params.studentId);
    if (!studentId) return fail(res, 400, "Invalid student session.");
    const notifications = await storage.getNotifications(studentId);
    res.json({ success: true, notifications });
});

app.use((error, req, res, next) => {
    console.error("Hostel API request failed:", error);
    if (res.headersSent) return next(error);
    return fail(res, 500, "The request could not be completed. Please try again.");
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

if (require.main === module) {
    app.listen(PORT, "127.0.0.1", () => {
        console.log(`Server is running at http://localhost:${PORT} (storage: ${storage.provider})`);
    });
}

module.exports = app;
