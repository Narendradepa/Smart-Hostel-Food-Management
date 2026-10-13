const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "hostel-food-test-"));
process.env.DATABASE_PATH = path.join(testDir, "test.db");

const db = require("../../database/db");
const app = require("../server");
const request = require("supertest");

before(() => {
    db.exec("DELETE FROM food_requests");
});

after(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
});

test("GET /api/status returns success", async () => {
    const response = await request(app).get("/api/status");
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
});

test("GET /api/requests returns an array", async () => {
    const response = await request(app).get("/api/requests");
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.ok(Array.isArray(response.body.requests));
});

test("POST /api/requests saves a valid food request", async () => {
    const response = await request(app)
        .post("/api/requests")
        .send({
            foodItem: "Test Idli",
            quantity: 2,
            notes: "Automated test"
        });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.request.foodItem, "Test Idli");
    assert.equal(response.body.request.quantity, 2);
});

test("POST /api/requests rejects an empty food item", async () => {
    const response = await request(app)
        .post("/api/requests")
        .send({ foodItem: " ", quantity: 1 });

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
});

test("POST /api/requests rejects an invalid quantity", async () => {
    const response = await request(app)
        .post("/api/requests")
        .send({ foodItem: "Idli", quantity: 0 });

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
});
