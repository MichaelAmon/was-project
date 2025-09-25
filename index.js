import process from 'node:process';
import express from 'express';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import axios from 'axios';
import 'dotenv/config'; // ES Module syntax for dotenv

// Create app
const app = express();
app.use(express.json()); // Understands WhatsApp message format

// Set port
const PORT = process.env.PORT || 3000;

// Get secrets from .env
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Office locations for geofencing
const OFFICE_LOCATIONS = [
  { name: 'Main', lat: 9.429241474535132, long: -1.0533786340817441, radius: 0.1 },
  { name: 'Nyankpala', lat: 9.404691157748209, long: -0.9838639320946208, radius: 0.1 }
];

// Memory to track user actions and location state
const userStates = new Map();

// Calculate distance between user and office
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius (km)
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Helper for distance
function toRad(value) {
  return value * Math.PI / 180;
}

// Find office based on location
function getOfficeName(lat, long) {
  const office = OFFICE_LOCATIONS.find(office => getDistance(lat, long, office.lat, office.long) <= office.radius);
  return office ? office.name : null;
}

// Connect to Google with processed key
const rawKey = process.env.GOOGLE_PRIVATE_KEY;
const processedKey = rawKey
  .replace(/\\\\n/g, '\n') // Handle double-escaped \\n
  .replace(/\\n/g, '\n');  // Handle single-escaped \n
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: processedKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// Verify WhatsApp webhook
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('🔒 Webhook verified');
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.log('🔒 Webhook verification failed');
    res.sendStatus(403);
  }
});

// Handle WhatsApp messages
app.post('/webhook', async (req, res) => {
  console.log('📨 Webhook received:', JSON.stringify(req.body, null, 2));
  const body = req.body;
  if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    console.log(`📱 Message from: +${from}, Type: ${message.type}, Body: ${message.text?.body || 'N/A'}`);

    let user = null;
    try {
      console.log('🔍 Looking up user:', `+${from}`);
      const staffDoc = new GoogleSpreadsheet(process.env.STAFF_SHEET_ID, serviceAccountAuth);
      await staffDoc.loadInfo();
      const staffSheet = staffDoc.sheetsByTitle['Staff Sheet'];
      const staffRows = await staffSheet.getRows();
      console.log('✅ Found', staffRows.length, 'staff rows');
      user = staffRows.find(row => row.get('Phone') === `+${from}`);
      console.log('👤 User found:', user ? user.get('Name') : 'NOT FOUND');
    } catch (error) {
      console.error('❌ Staff sheet error:', error.message);
      await sendMessage(from, 'System error. Please try again or contact admin.');
      return res.sendStatus(200);
    }

    if (!user) {
      console.log('❌ Unauthorized user:', `+${from}`);
      await sendMessage(from, 'Unauthorized user. Please contact admin to add your number.');
      return res.sendStatus(200);
    }

    if (message.type === 'text') {
      const text = message.text.body.toLowerCase();
      console.log('📝 Received text:', text);
      if (text === 'clock in' || text === 'clock out') {
        const allowedLocationsStr = user.get('Allowed Locations') || '';
        const allowedLocations = allowedLocationsStr.split(',').map(s => s.trim()).filter(s => s);
        userStates.set(from, { 
          action: text, 
          name: user.get('Name'), 
          department: user.get('Department'),
          allowedLocations: allowedLocations,
          awaitingLocation: true,
          requestTime: Date.now(),
          expiryTime: Date.now() + 10000 // 10-second window
        });
        console.log('👤 User state set:', user.name, text);
        await sendLocationRequest(from, `Please share your current location to ${text}. Click the button below.`);
        console.log(`📤 Sent location request to +${from}`);
      }
    } else if (message.type === 'location') {
      const userState = userStates.get(from);
      if (userState && userState.awaitingLocation) {
        const { latitude, longitude } = message.location;
        console.log(`👀 Validating location: ${latitude}, ${longitude}`);

        // Check timestamp
        if (Date.now() > userState.expiryTime) {
          await sendMessage(from, 'Time out, you took too long. Please try again.');
          userStates.delete(from);
          return res.sendStatus(200);
        }

        // Validate with geofencing
        const officeName = getOfficeName(latitude, longitude);
        if (!officeName) {
          await sendMessage(from, 'Invalid location. Please try again from an office.');
          return res.sendStatus(200);
        }

        if (!userState.allowedLocations.includes(officeName)) {
          await sendMessage(from, 'Not authorized at this location. Please try again.');
          userStates.delete(from);
          return res.sendStatus(200);
        }

        // Process action if valid
        await handleAction(from, userState, officeName);
        userStates.delete(from);
      }
    }
    res.sendStatus(200);
  } else {
    console.log('❌ Invalid webhook payload');
    res.sendStatus(404);
  }
});

// Handle clock in/out action
async function handleAction(from, userState, officeName) {
  const timestamp = new Date().toISOString();
  const attendanceDoc = new GoogleSpreadsheet(process.env.ATTENDANCE_SHEET_ID, serviceAccountAuth);
  await attendanceDoc.loadInfo();
  const attendanceSheet = attendanceDoc.sheetsByTitle['Attendance Sheet'];
  const dateStr = timestamp.split('T')[0];
  const rows = await attendanceSheet.getRows();
  let userRow = rows.find(row => row.get('Phone') === `+${from}` && row.get('Time In')?.startsWith(dateStr));

  let responseMessage = '';
  try {
    if (userState.action === 'clock in') {
      if (userRow && userRow.get('Time In')) {
        console.log('❌ Duplicate clock-in for:', from);
        responseMessage = 'You have already clocked in today.';
      } else {
        console.log('✅ Creating new clock-in for:', userState.name);
        await attendanceSheet.addRow({
          Name: userState.name,
          Phone: `+${from}`,
          'Time In': timestamp,
          'Time Out': '',
          Location: officeName,
          Department: userState.department
        });
        console.log('✅ Row added to Attendance Sheet');
        responseMessage = `Clocked in successfully at ${timestamp} at ${officeName}.`;
      }
    } else if (userState.action === 'clock out') {
      if (!userRow || !userRow.get('Time In')) {
        console.log('❌ No clock-in found for clock-out:', from);
        responseMessage = 'No clock-in record found for today.';
      } else if (userRow.get('Time Out')) {
        console.log('❌ Already clocked out today:', from);
        responseMessage = 'You have already clocked out today.';
      } else {
        console.log('✅ Updating clock-out for:', userState.name);
        userRow.set('Time Out', timestamp);
        userRow.set('Location', officeName);
        await userRow.save();
        console.log('✅ Row updated with Time Out');
        responseMessage = `Clocked out successfully at ${timestamp} at ${officeName}.`;
      }
    }
  } catch (error) {
    console.error('❌ Clock action failed:', error.message);
    responseMessage = 'Error processing your request. Please try again.';
  }

  if (responseMessage) {
    await sendMessage(from, responseMessage);
    console.log(`📤 ${userState.action === 'clock in' ? 'Clock-in' : 'Clock-out'} response sent to +${from}`);
  }
}

// Send WhatsApp location request
async function sendLocationRequest(to, text) {
  console.log(`📤 Sending location request to ${to}: "${text.substring(0, 50)}..."`);
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const data = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "location_request_message",
      body: {
        text: text
      },
      action: {
        button: "Send Location"
      }
    }
  };
  try {
    const response = await axios.post(url, data, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    console.log(`✅ Location request sent to ${to}: ${response.status}`);
    return response;
  } catch (error) {
    console.error(`❌ Location request FAILED to ${to}:`);
    console.error('  Status:', error.response?.status);
    console.error('  Error:', error.message);
    if (error.response?.data) {
      console.error('  Details:', JSON.stringify(error.response.data, null, 2));
    }
    // Fallback to text prompt if interactive fails
    await sendMessage(to, text + ' (Send your current location)');
  }
}

// Send WhatsApp reply
async function sendMessage(to, text) {
  console.log(`📤 Sending to ${to}: "${text.substring(0, 50)}..."`);
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: { body: text }
  };
  try {
    const response = await axios.post(url, data, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    console.log(`✅ Message sent to ${to}: ${response.status}`);
    return response;
  } catch (error) {
    console.error(`❌ Message FAILED to ${to}:`);
    console.error('  Status:', error.response?.status);
    console.error('  Error:', error.message);
    if (error.response?.data) {
      console.error('  Details:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    service: 'attendance-app',
    timestamp: new Date().toISOString()
  });
});

// Fixed server binding
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎉 Attendance app running on http://0.0.0.0:${PORT}`);
});
