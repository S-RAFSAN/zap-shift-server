const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();

// Middleware - MUST be before routes
// Configure CORS to allow requests from frontend
app.use(cors({
    origin: true, // Allow all origins
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

app.use(express.json());

// MongoDB connection - reuse connection for serverless
let cachedClient = null;
let cachedDb = null;
let cachedCollection = null;

async function connectToDatabase() {
    // Return cached connection if available and still connected
    if (cachedClient && cachedDb && cachedCollection) {
        try {
            // Verify the connection is still alive
            await cachedDb.admin().ping();
            return { client: cachedClient, db: cachedDb, collection: cachedCollection };
        } catch (error) {
            // Connection is dead, clear cache and reconnect
            console.log('Cached connection is dead, reconnecting...');
            cachedClient = null;
            cachedDb = null;
            cachedCollection = null;
        }
    }

    try {
        // Validate environment variables
        if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
            throw new Error('DB_USER and DB_PASSWORD environment variables are required');
        }

        // URL-encode both username and password to handle special characters
        const username = encodeURIComponent(process.env.DB_USER);
        const password = encodeURIComponent(process.env.DB_PASSWORD);
        const uri = `mongodb+srv://${username}:${password}@cluster0.a9td6ie.mongodb.net/?appName=Cluster0`;

        const client = new MongoClient(uri, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            },
            // Connection pool settings for serverless
            maxPoolSize: 1,
            minPoolSize: 1,
        });

        await client.connect();
        console.log('MongoDB connected successfully');
        
        const db = client.db("parcelDB");
        const collection = db.collection("parcels");

        // Cache the connection
        cachedClient = client;
        cachedDb = db;
        cachedCollection = collection;

        return { client, db, collection };
    } catch (error) {
        console.error("MongoDB connection error:", error.message);
        console.error("Error details:", {
            hasUser: !!process.env.DB_USER,
            hasPassword: !!process.env.DB_PASSWORD,
            errorCode: error.code,
            errorName: error.name
        });
        throw error;
    }
}

// Routes
app.get('/', (req, res) => {
    res.send('Zap Shift Server is running on Vercel');
});

// Handle favicon requests (browsers automatically request this)
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // No Content
});

app.get('/favicon.png', (req, res) => {
    res.status(204).end(); // No Content
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        // Check if environment variables are set
        const hasEnvVars = !!(process.env.DB_USER && process.env.DB_PASSWORD);
        
        let dbStatus = 'disconnected';
        let dbError = null;
        
        if (hasEnvVars) {
            // Try to connect to verify database connection
            try {
                const { collection } = await connectToDatabase();
                // Test the connection with a simple operation
                await collection.findOne({}, { projection: { _id: 1 } });
                dbStatus = 'connected';
            } catch (error) {
                dbStatus = 'error';
                dbError = error.message;
                console.error('Health check DB connection error:', error);
            }
        } else {
            dbError = 'DB_USER or DB_PASSWORD environment variables not set';
        }
        
        res.json({
            status: 'ok',
            database: dbStatus,
            hasEnvVars: hasEnvVars,
            error: dbError,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            database: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Test endpoint
app.get('/parcels/test', (req, res) => {
    const testData = [
        { id: '1', _id: '1', test: true, message: 'Test parcel 1' },
        { id: '2', _id: '2', test: true, message: 'Test parcel 2' },
        { id: '3', _id: '3', test: true, message: 'Test parcel 3' }
    ];
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(testData);
});

app.get('/parcels', async (req, res) => {
    try {
        const { collection } = await connectToDatabase();
        
        const { email } = req.query;
        
        // If email is provided, filter by email
        let query = {};
        if (email) {
            query = {
                $or: [
                    { email: { $regex: email, $options: 'i' } },
                    { userEmail: { $regex: email, $options: 'i' } },
                    { senderEmail: { $regex: email, $options: 'i' } },
                    { recipientEmail: { $regex: email, $options: 'i' } },
                    { creatorEmail: { $regex: email, $options: 'i' } }
                ]
            };
        }
        
        // Find parcels and sort by latest first
        const parcels = await collection
            .find(query)
            .sort({ 
                createdAt: -1,
                date: -1,
                timestamp: -1,
                _id: -1
            })
            .toArray();
        
        // Convert MongoDB ObjectId to string for JSON serialization
        const parcelsArray = parcels.map(parcel => ({
            ...parcel,
            _id: parcel._id.toString(),
            id: parcel._id.toString()
        }));
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).json(parcelsArray);
    } catch (error) {
        console.error('Error fetching parcels:', error);
        res.status(500).json({ error: 'Failed to fetch parcels', message: error.message });
    }
});

// Get parcels by user email (alternative endpoint)
app.get('/parcels/user/:email', async (req, res) => {
    try {
        const { collection } = await connectToDatabase();
        
        const email = req.params.email;
        
        const query = {
            $or: [
                { email: { $regex: email, $options: 'i' } },
                { userEmail: { $regex: email, $options: 'i' } },
                { senderEmail: { $regex: email, $options: 'i' } },
                { recipientEmail: { $regex: email, $options: 'i' } },
                { creatorEmail: { $regex: email, $options: 'i' } }
            ]
        };
        
        const parcels = await collection
            .find(query)
            .sort({ 
                createdAt: -1,
                date: -1,
                timestamp: -1,
                _id: -1
            })
            .toArray();
        
        const parcelsArray = parcels.map(parcel => ({
            ...parcel,
            _id: parcel._id.toString(),
            id: parcel._id.toString()
        }));
        
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(parcelsArray);
    } catch (error) {
        console.error('Error fetching parcels by email:', error);
        res.status(500).json({ error: 'Failed to fetch parcels', message: error.message });
    }
});

app.post('/parcels', async (req, res) => {
    try {
        const { collection } = await connectToDatabase();
        
        const parcel = req.body;
        const result = await collection.insertOne(parcel);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(201).json({
            insertedId: result.insertedId.toString(),
            acknowledged: result.acknowledged
        });
    } catch (error) {
        console.error('Error inserting parcel:', error);
        res.status(500).json({ error: 'Failed to insert parcel', message: error.message });
    }
});

// Export the Express app as a serverless function
module.exports = app;
