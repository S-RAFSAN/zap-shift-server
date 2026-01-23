const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const app = express();
const { MongoClient, ServerApiVersion } = require("mongodb");
dotenv.config();

// Middleware - MUST be before routes
// Configure CORS to allow requests from frontend
app.use(cors({
    origin: true, // Allow all origins in development
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

// Log all requests for debugging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    console.log('Origin:', req.headers.origin);
    
    // Log response for /parcels endpoint
    if (req.path === '/parcels' && req.method === 'GET') {
        const originalJson = res.json;
        res.json = function(data) {
            console.log('Response data type:', Array.isArray(data) ? 'Array' : typeof data);
            console.log('Response data length:', Array.isArray(data) ? data.length : 'N/A');
            if (Array.isArray(data) && data.length > 0) {
                console.log('Response sample (first item):', JSON.stringify(data[0], null, 2));
            }
            return originalJson.call(this, data);
        };
    }
    next();
});

app.use(express.json());

// URL-encode both username and password to handle special characters
const username = encodeURIComponent(process.env.DB_USER || '');
const password = encodeURIComponent(process.env.DB_PASSWORD || '');
const uri = `mongodb+srv://${username}:${password}@cluster0.a9td6ie.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db;
let parcelsCollection;

async function run() {
    try {
        // Validate environment variables
        if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
            console.error('Warning: DB_USER and/or DB_PASSWORD not set. MongoDB connection will fail.');
            console.error('Server will still start, but database operations will not work.');
            return;
        }

        // Connect the client to the server
        await client.connect();
        console.log("Connected to MongoDB!");

        db = client.db("parcelDB");
        parcelsCollection = db.collection("parcels");

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } catch (error) {
        console.error("MongoDB connection error:", error.message);
        console.error("Server will continue running, but database operations will fail.");
        // Don't throw - let the server start even if DB connection fails
    }
    // DON'T close the connection - keep it open for requests
}

// Start MongoDB connection (non-blocking)
run().catch((error) => {
    console.error("Failed to initialize MongoDB:", error.message);
    // Don't crash the server
});

// Routes
app.get('/', (req, res) => {
    res.send('Zap Shift Server is running');
});

// Health check endpoint (doesn't require DB)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        database: parcelsCollection ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// Test endpoint to verify frontend can receive array data
app.get('/parcels/test', (req, res) => {
    const testData = [
        { id: '1', _id: '1', test: true, message: 'Test parcel 1' },
        { id: '2', _id: '2', test: true, message: 'Test parcel 2' },
        { id: '3', _id: '3', test: true, message: 'Test parcel 3' }
    ];
    console.log('Test endpoint called - returning', testData.length, 'test parcels');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(testData);
});

app.get('/parcels', async (req, res) => {
    try {
        if (!parcelsCollection) {
            return res.status(503).send({ error: 'Database not connected' });
        }
        
        const { email } = req.query;
        
        // If email is provided, filter by email
        let query = {};
        if (email) {
            // Search in common email fields (case-insensitive)
            query = {
                $or: [
                    { email: { $regex: email, $options: 'i' } },
                    { userEmail: { $regex: email, $options: 'i' } },
                    { senderEmail: { $regex: email, $options: 'i' } },
                    { recipientEmail: { $regex: email, $options: 'i' } }
                ]
            };
        }
        
        // Find parcels and sort by latest first
        // Sort by createdAt, date, timestamp, or _id (which contains creation timestamp)
        const parcels = await parcelsCollection
            .find(query)
            .sort({ 
                createdAt: -1,  // Try createdAt first (descending)
                date: -1,       // Fallback to date field
                timestamp: -1,  // Fallback to timestamp
                _id: -1         // Final fallback: sort by MongoDB _id (contains timestamp)
            })
            .toArray();
        
        // Convert MongoDB ObjectId to string for JSON serialization
        const parcelsArray = parcels.map(parcel => ({
            ...parcel,
            _id: parcel._id.toString(),
            id: parcel._id.toString() // Also add 'id' field for convenience
        }));
        
        // Log for debugging
        console.log(`\n=== GET /parcels ===`);
        console.log(`Found ${parcelsArray.length} parcels`);
        console.log(`Query:`, JSON.stringify(query, null, 2));
        if (email) {
            console.log(`Filtered by email: ${email}`);
        }
        if (parcelsArray.length > 0) {
            console.log('First parcel:', JSON.stringify(parcelsArray[0], null, 2));
        } else {
            console.log('No parcels found - query returned empty array');
        }
        console.log(`Response will be sent as array with ${parcelsArray.length} items\n`);
        
        // Set explicit headers and send response
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).json(parcelsArray);
    } catch (error) {
        console.error('Error fetching parcels:', error);
        res.status(500).send({ error: 'Failed to fetch parcels', message: error.message });
    }
});

// Get parcels by user email (alternative endpoint)
app.get('/parcels/user/:email', async (req, res) => {
    try {
        if (!parcelsCollection) {
            return res.status(503).send({ error: 'Database not connected' });
        }
        
        const email = req.params.email;
        
        // Search in common email fields (case-insensitive)
        const query = {
            $or: [
                { email: { $regex: email, $options: 'i' } },
                { userEmail: { $regex: email, $options: 'i' } },
                { senderEmail: { $regex: email, $options: 'i' } },
                { recipientEmail: { $regex: email, $options: 'i' } }
            ]
        };
        
        // Find parcels and sort by latest first
        const parcels = await parcelsCollection
            .find(query)
            .sort({ 
                createdAt: -1,  // Try createdAt first (descending)
                date: -1,       // Fallback to date field
                timestamp: -1,  // Fallback to timestamp
                _id: -1         // Final fallback: sort by MongoDB _id (contains timestamp)
            })
            .toArray();
        
        // Convert MongoDB ObjectId to string for JSON serialization
        const parcelsArray = parcels.map(parcel => ({
            ...parcel,
            _id: parcel._id.toString(),
            id: parcel._id.toString() // Also add 'id' field for convenience
        }));
        
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(parcelsArray);
    } catch (error) {
        console.error('Error fetching parcels by email:', error);
        res.status(500).send({ error: 'Failed to fetch parcels', message: error.message });
    }
});

app.post('/parcels', async (req, res) => {
    try {
        console.log('POST /parcels received');
        console.log('Request origin:', req.headers.origin);
        console.log('Request headers:', req.headers);
        console.log('Request body:', req.body);

        if (!parcelsCollection) {
            console.log('Database not connected');
            return res.status(503).send({ error: 'Database not connected' });
        }
        const parcel = req.body;
        const result = await parcelsCollection.insertOne(parcel);
        console.log('Parcel inserted with ID:', result.insertedId);
        res.status(201).send(result);
    } catch (error) {
        console.error('Error inserting parcel:', error);
        res.status(500).send({ error: 'Failed to insert parcel', message: error.message });
    }
});

// Delete parcel by ID
app.delete('/parcels/:id', async (req, res) => {
    try {
        console.log(`DELETE /parcels/${req.params.id} - Request received`);
        
        if (!parcelsCollection) {
            console.log('Database not connected');
            return res.status(503).send({ error: 'Database not connected' });
        }
        
        const parcelId = req.params.id;
        console.log('Parcel ID to delete:', parcelId);
        
        // Validate ID format
        const { ObjectId } = require('mongodb');
        if (!ObjectId.isValid(parcelId)) {
            console.log('Invalid ID format:', parcelId);
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.status(400).json({ 
                error: 'Invalid parcel ID format',
                receivedId: parcelId
            });
        }
        
        // Delete the parcel
        const deleteQuery = { _id: new ObjectId(parcelId) };
        console.log('Delete query:', deleteQuery);
        
        const result = await parcelsCollection.deleteOne(deleteQuery);
        console.log('Delete result:', result);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (result.deletedCount === 0) {
            console.log('Parcel not found with ID:', parcelId);
            return res.status(404).json({ 
                error: 'Parcel not found',
                parcelId: parcelId
            });
        }
        
        console.log('Parcel deleted successfully:', parcelId);
        res.status(200).json({
            message: 'Parcel deleted successfully',
            deletedId: parcelId,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('Error deleting parcel:', error);
        console.error('Error stack:', error.stack);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(500).json({ 
            error: 'Failed to delete parcel', 
            message: error.message
        });
    }
});

// Delete parcel by ID (alternative - accepts ID in request body)
app.delete('/parcels', async (req, res) => {
    try {
        console.log('DELETE /parcels - Request received with body:', req.body);
        
        if (!parcelsCollection) {
            console.log('Database not connected');
            return res.status(503).send({ error: 'Database not connected' });
        }
        
        const { ObjectId } = require('mongodb');
        
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
        
        // Delete the parcel
        const deleteQuery = { _id: new ObjectId(parcelId) };
        console.log('Delete query:', deleteQuery);
        
        const result = await parcelsCollection.deleteOne(deleteQuery);
        console.log('Delete result:', result);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (result.deletedCount === 0) {
            console.log('Parcel not found with ID:', parcelId);
            return res.status(404).json({ 
                error: 'Parcel not found',
                parcelId: parcelId
            });
        }
        
        console.log('Parcel deleted successfully:', parcelId);
        res.status(200).json({
            message: 'Parcel deleted successfully',
            deletedId: parcelId,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('Error deleting parcel:', error);
        console.error('Error stack:', error.stack);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(500).json({ 
            error: 'Failed to delete parcel', 
            message: error.message
        });
    }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`API endpoint: http://localhost:${PORT}/parcels`);
});
