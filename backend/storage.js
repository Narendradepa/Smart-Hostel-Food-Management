const configuredBackend = (process.env.HOSTEL_STORAGE || "sqlite").toLowerCase();
if (!["sqlite", "dynamodb"].includes(configuredBackend)) {
    throw new Error("HOSTEL_STORAGE must be either sqlite or dynamodb.");
}

const isDynamoDb = configuredBackend === "dynamodb";
const tablePrefix = process.env.DYNAMODB_TABLE_PREFIX || "SmartHostelFoodManagement-";
const tableSuffixes = {
    food_requests: "FoodRequests",
    menus: "Menus",
    food_preferences: "FoodPreferences",
    feedback: "Feedback",
    complaints: "Complaints",
    staff_ratings: "StaffRatings",
    notifications: "Notifications"
};

const sqliteTables = {
    food_requests: "food_requests",
    menus: "menus",
    food_preferences: "food_preferences",
    feedback: "feedback",
    complaints: "complaints",
    staff_ratings: "staff_ratings",
    notifications: "notifications"
};

let db;
let dynamo;
let commands;

if (isDynamoDb) {
    const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
    const {
        DynamoDBDocumentClient,
        GetCommand,
        PutCommand,
        ScanCommand,
        UpdateCommand,
        QueryCommand
    } = require("@aws-sdk/lib-dynamodb");

    const baseClient = new DynamoDBClient({
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
    });
    dynamo = DynamoDBDocumentClient.from(baseClient, {
        marshallOptions: { removeUndefinedValues: true }
    });
    commands = { GetCommand, PutCommand, ScanCommand, UpdateCommand, QueryCommand };
} else {
    db = require("../database/db");
}

function tableName(entity) {
    const suffix = tableSuffixes[entity];
    if (!suffix) throw new Error(`Unknown storage entity: ${entity}`);
    return `${tablePrefix}${suffix}`;
}

function timestamp() {
    return new Date().toISOString();
}

function sqliteTimestamp() {
    return timestamp().slice(0, 19).replace("T", " ");
}

function validateEntity(entity) {
    if (!tableSuffixes[entity]) throw new Error(`Unknown storage entity: ${entity}`);
}

async function scanAll(entity) {
    validateEntity(entity);
    const items = [];
    let ExclusiveStartKey;
    do {
        const result = await dynamo.send(new commands.ScanCommand({
            TableName: tableName(entity),
            ExclusiveStartKey
        }));
        items.push(...(result.Items || []));
        ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

async function nextId(entity) {
    const result = await dynamo.send(new commands.UpdateCommand({
        TableName: tableName(entity),
        Key: { id: 0 },
        UpdateExpression: "SET #kind = if_not_exists(#kind, :kind) ADD #counter :one",
        ExpressionAttributeNames: { "#counter": "counter", "#kind": "record_type" },
        ExpressionAttributeValues: { ":one": 1, ":kind": "__counter__" },
        ReturnValues: "UPDATED_NEW"
    }));
    return result.Attributes.counter;
}

function sqliteRows(entity) {
    const table = sqliteTables[entity];
    if (["food_requests", "feedback", "complaints", "staff_ratings", "notifications"].includes(entity)) {
        return db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 200`).all();
    }
    return db.prepare(`SELECT * FROM ${table}`).all();
}

async function list(entity) {
    validateEntity(entity);
    if (!isDynamoDb) return sqliteRows(entity);
    const items = await scanAll(entity);
    if (["food_requests", "feedback", "complaints", "staff_ratings", "notifications"].includes(entity)) {
        return items.filter((item) => Number(item.id) > 0)
            .sort((a, b) => Number(b.id) - Number(a.id))
            .slice(0, 200);
    }
    return items;
}

async function get(entity, id) {
    validateEntity(entity);
    if (!isDynamoDb) {
        const key = entity === "menus" ? "menu_date" : entity === "food_preferences" ? "student_id" : "id";
        return db.prepare(`SELECT * FROM ${sqliteTables[entity]} WHERE ${key} = ?`).get(id);
    }
    const key = entity === "menus" ? { menu_date: id }
        : entity === "food_preferences" ? { student_id: id }
            : { id: Number(id) };
    const result = await dynamo.send(new commands.GetCommand({
        TableName: tableName(entity),
        Key: key
    }));
    return result.Item;
}

async function insert(entity, values) {
    validateEntity(entity);
    const now = isDynamoDb ? timestamp() : sqliteTimestamp();

    if (!isDynamoDb) {
        if (entity === "food_requests") {
            const result = db.prepare(`
                INSERT INTO food_requests (food_item, quantity, notes, student_id)
                VALUES (?, ?, ?, ?)
            `).run(values.food_item, values.quantity, values.notes, values.student_id || "");
            return { ...values, id: result.lastInsertRowid, status: "pending", created_at: now };
        }
        if (entity === "feedback" || entity === "complaints") {
            const result = db.prepare(`INSERT INTO ${sqliteTables[entity]} (student_id, message) VALUES (?, ?)`)
                .run(values.student_id, values.message);
            return {
                ...values,
                id: result.lastInsertRowid,
                status: entity === "complaints" ? "open" : "new",
                created_at: now,
                ...(entity === "complaints" ? { updated_at: now } : {})
            };
        }
        if (entity === "staff_ratings") {
            const result = db.prepare("INSERT INTO staff_ratings (student_id, rating, comment) VALUES (?, ?, ?)")
                .run(values.student_id, values.rating, values.comment);
            return { ...values, id: result.lastInsertRowid, created_at: now };
        }
        if (entity === "notifications") {
            const result = db.prepare("INSERT INTO notifications (student_id, message) VALUES (?, ?)")
                .run(values.student_id || null, values.message);
            return { ...values, id: result.lastInsertRowid, created_at: now };
        }
        throw new Error(`Insert is not supported for ${entity}.`);
    }

    const id = await nextId(entity);
    const item = { ...values, id, created_at: now };
    if (entity === "food_requests") item.status = "pending";
    if (entity === "feedback") item.status = "new";
    if (entity === "complaints") {
        item.status = "open";
        item.updated_at = now;
    }
    if (entity === "notifications" && !item.student_id) item.student_id = "GLOBAL";
    await dynamo.send(new commands.PutCommand({
        TableName: tableName(entity),
        Item: item,
        ConditionExpression: "attribute_not_exists(id)"
    }));
    return item;
}

async function update(entity, id, fields) {
    validateEntity(entity);
    const allowed = {
        food_requests: ["status"],
        feedback: ["status"],
        complaints: ["status", "updated_at"]
    }[entity];
    if (!allowed || Object.keys(fields).some((key) => !allowed.includes(key))) {
        throw new Error(`Update is not supported for ${entity}.`);
    }

    if (!isDynamoDb) {
        const table = sqliteTables[entity];
        const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(", ");
        const result = db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`)
            .run(...Object.values(fields), Number(id));
        return result.changes > 0 ? get(entity, Number(id)) : undefined;
    }

    const existing = await get(entity, id);
    if (!existing || Number(existing.id) <= 0) return undefined;

    const names = {};
    const values = {};
    const assignments = Object.entries(fields).map(([key, value], index) => {
        names[`#field${index}`] = key;
        values[`:value${index}`] = value;
        return `#field${index} = :value${index}`;
    });
    const result = await dynamo.send(new commands.UpdateCommand({
        TableName: tableName(entity),
        Key: { id: Number(id) },
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW"
    }));
    return result.Attributes;
}

async function getMenu(menuDate) {
    if (!isDynamoDb) {
        let current = db.prepare("SELECT * FROM menus WHERE menu_date = ?").get(menuDate);
        if (current) return current;
        const previous = db.prepare("SELECT breakfast, lunch, dinner FROM menus ORDER BY menu_date DESC LIMIT 1").get();
        const values = previous || {
            breakfast: "Idli, Sambar, Chutney",
            lunch: "Rice, Dal, Vegetable Curry",
            dinner: "Chapati, Curry, Rice"
        };
        db.prepare(`
            INSERT OR IGNORE INTO menus (menu_date, breakfast, lunch, dinner)
            VALUES (?, ?, ?, ?)
        `).run(menuDate, values.breakfast, values.lunch, values.dinner);
        return db.prepare("SELECT * FROM menus WHERE menu_date = ?").get(menuDate);
    }

    let current = await get("menus", menuDate);
    if (current) return current;
    const previous = (await scanAll("menus"))
        .sort((a, b) => String(b.menu_date).localeCompare(String(a.menu_date)))[0];
    const values = previous || {
        breakfast: "Idli, Sambar, Chutney",
        lunch: "Rice, Dal, Vegetable Curry",
        dinner: "Chapati, Curry, Rice"
    };
    const item = {
        menu_date: menuDate,
        breakfast: values.breakfast,
        lunch: values.lunch,
        dinner: values.dinner,
        updated_at: timestamp()
    };
    try {
        await dynamo.send(new commands.PutCommand({
            TableName: tableName("menus"),
            Item: item,
            ConditionExpression: "attribute_not_exists(menu_date)"
        }));
    } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
    }
    current = await get("menus", menuDate);
    return current;
}

async function saveMenu(menuDate, values) {
    const item = {
        menu_date: menuDate,
        breakfast: values.breakfast,
        lunch: values.lunch,
        dinner: values.dinner,
        updated_at: isDynamoDb ? timestamp() : sqliteTimestamp()
    };
    if (!isDynamoDb) {
        db.prepare(`
            INSERT INTO menus (menu_date, breakfast, lunch, dinner, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(menu_date) DO UPDATE SET
                breakfast = excluded.breakfast,
                lunch = excluded.lunch,
                dinner = excluded.dinner,
                updated_at = CURRENT_TIMESTAMP
        `).run(menuDate, values.breakfast, values.lunch, values.dinner);
        return getMenu(menuDate);
    }
    await dynamo.send(new commands.PutCommand({ TableName: tableName("menus"), Item: item }));
    return item;
}

async function getPreference(studentId) {
    if (!isDynamoDb) {
        return db.prepare(`
            SELECT diet, less_spicy, updated_at FROM food_preferences WHERE student_id = ?
        `).get(studentId) || { diet: "vegetarian", less_spicy: 0 };
    }
    const result = await dynamo.send(new commands.GetCommand({
        TableName: tableName("food_preferences"),
        Key: { student_id: studentId },
        ProjectionExpression: "diet, less_spicy, updated_at"
    }));
    return result.Item || { diet: "vegetarian", less_spicy: 0 };
}

async function savePreference(studentId, diet, lessSpicy) {
    const item = {
        student_id: studentId,
        diet,
        less_spicy: Number(lessSpicy),
        updated_at: isDynamoDb ? timestamp() : sqliteTimestamp()
    };
    if (!isDynamoDb) {
        db.prepare(`
            INSERT INTO food_preferences (student_id, diet, less_spicy, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(student_id) DO UPDATE SET
                diet = excluded.diet, less_spicy = excluded.less_spicy, updated_at = CURRENT_TIMESTAMP
        `).run(studentId, diet, Number(lessSpicy));
        return item;
    }
    await dynamo.send(new commands.PutCommand({ TableName: tableName("food_preferences"), Item: item }));
    return item;
}

async function getReports() {
    if (!isDynamoDb) {
        return db.prepare(`
            SELECT
                (SELECT COUNT(*) FROM food_requests) AS total_requests,
                (SELECT COUNT(*) FROM food_requests WHERE status = 'pending') AS pending_requests,
                (SELECT COUNT(*) FROM feedback) AS total_feedback,
                (SELECT COUNT(*) FROM complaints) AS total_complaints,
                (SELECT COUNT(*) FROM complaints WHERE status != 'resolved') AS open_complaints,
                (SELECT COUNT(*) FROM staff_ratings) AS total_ratings,
                (SELECT ROUND(AVG(rating), 1) FROM staff_ratings) AS average_rating
        `).get();
    }
    const [requests, feedback, complaints, ratings] = await Promise.all([
        scanAll("food_requests"), scanAll("feedback"), scanAll("complaints"), scanAll("staff_ratings")
    ]);
    const realItems = (items) => items.filter((item) => Number(item.id) > 0);
    const realRequests = realItems(requests);
    const realFeedback = realItems(feedback);
    const realComplaints = realItems(complaints);
    const realRatings = realItems(ratings);
    return {
        total_requests: realRequests.length,
        pending_requests: realRequests.filter((item) => item.status === "pending").length,
        total_feedback: realFeedback.length,
        total_complaints: realComplaints.length,
        open_complaints: realComplaints.filter((item) => item.status !== "resolved").length,
        total_ratings: realRatings.length,
        average_rating: realRatings.length
            ? Math.round(realRatings.reduce((total, item) => total + Number(item.rating), 0) / realRatings.length * 10) / 10
            : null
    };
}

async function getNotifications(studentId) {
    if (!isDynamoDb) {
        return db.prepare(`
            SELECT id, message, created_at FROM notifications
            WHERE student_id = ? OR student_id IS NULL
            ORDER BY id DESC LIMIT 50
        `).all(studentId);
    }
    const query = (recipient) => dynamo.send(new commands.QueryCommand({
        TableName: tableName("notifications"),
        IndexName: "StudentCreatedAtIndex",
        KeyConditionExpression: "student_id = :student_id",
        ExpressionAttributeValues: { ":student_id": recipient },
        ScanIndexForward: false,
        Limit: 50
    }));
    const [personal, global] = await Promise.all([query(studentId), query("GLOBAL")]);
    return [...(personal.Items || []), ...(global.Items || [])]
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, 50)
        .map(({ id, message, created_at }) => ({ id, message, created_at }));
}

module.exports = {
    provider: isDynamoDb ? "dynamodb" : "sqlite",
    list,
    get,
    insert,
    update,
    getMenu,
    saveMenu,
    getPreference,
    savePreference,
    getReports,
    getNotifications
};
