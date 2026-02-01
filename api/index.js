const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require('stripe');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Middleware - MUST be before routes
// Configure CORS to allow requests from frontend
app.use(cors({
    origin: true, // Allow all origins
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

// Stripe webhook - must use raw body for signature verification (before express.json())
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(503).json({ error: 'Stripe not configured' });
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        console.log('Payment succeeded:', paymentIntent.id, paymentIntent.metadata);
    }
    res.json({ received: true });
});

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

// Create PaymentIntent (Stripe)
app.post('/create-payment-intent', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in env' });
        }
        const { amount, currency = 'usd', metadata = {} } = req.body;
        if (!amount || amount < 50) {
            return res.status(400).json({ error: 'Amount is required (minimum 50 cents)' });
        }
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount),
            currency: currency.toLowerCase(),
            automatic_payment_methods: { enabled: true },
            metadata
        });
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
        });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Failed to create payment intent', message: error.message });
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

// Get parcel by ID
app.get('/parcels/:id', async (req, res) => {
    try {
        const { collection } = await connectToDatabase();

        const parcelId = req.params.id;

        if (!ObjectId.isValid(parcelId)) {
            return res.status(400).json({
                error: 'Invalid parcel ID format',
                receivedId: parcelId
            });
        }

        const parcel = await collection.findOne({ _id: new ObjectId(parcelId) });

        if (!parcel) {
            return res.status(404).json({
                error: 'Parcel not found',
                parcelId: parcelId
            });
        }

        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({
            ...parcel,
            _id: parcel._id.toString(),
            id: parcel._id.toString()
        });
    } catch (error) {
        console.error('Error fetching parcel:', error);
        res.status(500).json({ error: 'Failed to fetch parcel', message: error.message });
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

// Shared delete-by-id handler (reused for /parcels/:id and /api/parcels/:id)
async function handleDeleteParcelById(req, res) {
    const { collection } = await connectToDatabase();
    let parcelId = (req.params && req.params.id) || (req.path && req.path.split('/').pop());
    if (typeof parcelId === 'string') parcelId = parcelId.trim();
    console.log('Parcel ID to delete:', JSON.stringify(parcelId));
    
    if (!parcelId || !ObjectId.isValid(parcelId)) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(400).json({ error: 'Invalid parcel ID format', receivedId: parcelId });
    }
    
    let result = await collection.deleteOne({ _id: new ObjectId(parcelId) });
    if (result.deletedCount === 0) result = await collection.deleteOne({ _id: parcelId });
    if (result.deletedCount === 0) result = await collection.deleteOne({ id: parcelId });
    console.log('Delete result:', result);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (result.deletedCount === 0) {
        return res.status(404).json({ 
            error: 'Parcel not found',
            parcelId,
            hint: 'Parcel may have been deleted already, or ID is incorrect. Use GET /parcels to list parcels.'
        });
    }
    res.status(200).json({ message: 'Parcel deleted successfully', deletedId: parcelId, deletedCount: result.deletedCount });
}

// Delete parcel by ID (from URL parameter)
app.delete('/parcels/:id', async (req, res) => {
    try {
        console.log(`DELETE /parcels/${req.params.id} - Request received`);
        await handleDeleteParcelById(req, res);
    } catch (error) {
        console.error('Error deleting parcel:', error);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(500).json({ error: 'Failed to delete parcel', message: error.message });
    }
});

// Also handle /api/parcels/:id in case Vercel passes /api prefix
app.delete('/api/parcels/:id', async (req, res) => {
    try {
        console.log(`DELETE /api/parcels/${req.params.id} - Request received`);
        await handleDeleteParcelById(req, res);
    } catch (error) {
        console.error('Error deleting parcel:', error);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(500).json({ error: 'Failed to delete parcel', message: error.message });
    }
});

// Delete parcel by ID (alternative - accepts ID in request body)
app.delete('/parcels', async (req, res) => {
    try {
        console.log('DELETE /parcels - Request received with body:', req.body);
        
        const { collection } = await connectToDatabase();
        
        // Get ID from body or query
        const parcelId = req.body.id || req.body._id || req.query.id;
        
        if (!parcelId) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.status(400).json({ 
                error: 'Parcel ID is required',
                hint: 'Provide id in request body or use DELETE /parcels/:id'
            });
        }
        
        console.log('Parcel ID to delete:', parcelId);
        
        // Validate ID format
        if (!ObjectId.isValid(parcelId)) {
            console.log('Invalid ID format:', parcelId);
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.status(400).json({ 
                error: 'Invalid parcel ID format',
                receivedId: parcelId
            });
        }
        
        // Delete: try ObjectId, then _id as string, then id field
        let result = await collection.deleteOne({ _id: new ObjectId(parcelId) });
        if (result.deletedCount === 0) result = await collection.deleteOne({ _id: parcelId });
        if (result.deletedCount === 0) result = await collection.deleteOne({ id: parcelId });
        console.log('Delete result:', result);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Parcel not found', parcelId });
        }
        res.status(200).json({ message: 'Parcel deleted successfully', deletedId: parcelId, deletedCount: result.deletedCount });
    } catch (error) {
        console.error('Error deleting parcel:', error);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(500).json({ error: 'Failed to delete parcel', message: error.message });
    }
});

// Export the Express app as a serverless function
module.exports = app;
