     // Load tools – like getting ingredients for a recipe
                   // const express = require('express'); // Handles WhatsApp messages
                   // const { GoogleSpreadsheet } = require('google-spreadsheet'); // Connects to sheets
                   // const { JWT } = require('google-auth-library'); // Logs into Google
                   // const axios = require('axios'); // Sends WhatsApp replies
                   // require('dotenv').config(); // Loads .env secrets

     import express from 'express';
     import { GoogleSpreadsheet } from 'google-spreadsheet';
     import { JWT } from 'google-auth-library';
     import axios from 'axios';
     import 'dotenv/config';  // ← Different syntax for dotenv

     // Create app – like starting a machine
     const app = express();
     app.use(express.json()); // Understands WhatsApp message format

     // Set port – where app listens on VPS
     const PORT = process.env.PORT || 3000;

     // Get secrets from .env
     const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
     const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
     const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

     // Office locations – replace with yours from Step 2
     const OFFICE_LOCATIONS = [
       { name: 'Main', lat: 9.429241474535132, long: -1.0533786340817441, radius: 0.5 }, // REPLACE
       { name: 'Nyankpala', lat: 9.404691157748209, long: -0.9838639320946208, radius: 0.5 }  // REPLACE
     ];

     // Memory to track user actions (temporary, like a notepad)
     const userStates = new Map();

     // Calculate distance between user and office
     function getDistance(lat1, lon1, lat2, lon2) {
       const R = 6371; // Earth’s radius (km)
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

     // Connect to Google
    // NEW: Handle both double and single escaping
          const rawKey = process.env.GOOGLE_PRIVATE_KEY;
          const processedKey = rawKey
            .replace(/\\\\n/g, '\n')  // First handle double-escaped \\n
            .replace(/\\n/g, '\n');   // Then handle single-escaped \n
          
          const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: processedKey,        // ← Use processed key
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
     // Verify WhatsApp webhook
     app.get('/webhook', (req, res) => {
       if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
         res.status(200).send(req.query['hub.challenge']);
       } else {
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
            console.log(`📱 Message from: +${from}`);

         // Check Staff sheet (UPDATED: Use one doc if IDs match, with titles)
        // WRAPPED USER LOOKUP WITH TRY-CATCH
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
           return res.sendStatus(500);
    }

         if (!user) {
           console.log('❌ Unauthorized user:', `+${from}`);
           await sendMessage(from, 'Unauthorized user. Please contact admin to add your number.');
           return res.sendStatus(200);
    }

         if (message.type === 'text') {
           const text = message.text.body.toLowerCase();
           if (text === 'clock in' || text === 'clock out') {
             // UPDATED: Fetch and parse allowed locations
             const allowedLocationsStr = user.get('Allowed Locations') || '';
             const allowedLocations = allowedLocationsStr.split(',').map(s => s.trim()).filter(s => s);
             userStates.set(from, { 
               action: text, 
               name: user.get('Name'), 
               department: user.get('Department'),
               allowedLocations: allowedLocations  // NEW: Store for location check
             });
             await sendMessage(from, `Please share your location to confirm ${text}.`);
                console.log(`📤 Sent location request to +${from}`);
           }
     } else if (message.type === 'location') {
  const { latitude, longitude } = message.location;
  const officeName = getOfficeName(latitude, longitude);
  if (!officeName) {
    await sendMessage(from, 'Location not at any office. Try again.');
    console.log('❌ Location not matched');
    return res.sendStatus(200);
  }

  const userState = userStates.get(from);
  if (!userState) {
    await sendMessage(from, 'Please send "clock in" or "clock out" first.');
    console.log('❌ No user state found');
    return res.sendStatus(200);
  }

  // NEW: Check if office is allowed for this user
  if (userState.allowedLocations.length === 0 || !userState.allowedLocations.includes(officeName)) {
    await sendMessage(from, 'Not authorized at this location.');
    userStates.delete(from);
    console.log('❌ Unauthorized location');
    return res.sendStatus(200);
  }

  const timestamp = new Date().toISOString();
  const attendanceDoc = new GoogleSpreadsheet(process.env.ATTENDANCE_SHEET_ID, serviceAccountAuth);
  await attendanceDoc.loadInfo();
  const attendanceSheet = attendanceDoc.sheetsByTitle['Attendance Sheet'];
  const rows = await attendanceSheet.getRows();
  let userRow = rows.find(row => row.get('Phone') === `+${from}` && row.get('Time In')?.startsWith(timestamp.split('T')[0]));

  try {
    if (userState.action === 'clock in') {
      if (userRow && userRow.get('Time In')) {
        console.log('❌ Duplicate clock-in for:', from);
        await sendMessage(from, 'You already clocked in today.');
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
        console.log(`📤 Sending clock-in confirmation to ${from}`);
        await sendMessage(from, `Clocked in successfully at ${timestamp} at ${officeName}.`);
        console.log('✅ Clock-in message sent');
      }
    } else if (userState.action === 'clock out') { // Same level as clock in
      if (!userRow || !userRow.get('Time In')) {
        console.log('❌ No clock-in found for clock-out:', from);
        await sendMessage(from, 'No clock-in record found for today.');
      } else if (userRow.get('Time Out')) {
        console.log('❌ Already clocked out today:', from);
        await sendMessage(from, 'You already clocked out today.');
      } else {
        console.log('✅ Updating clock-out for:', userState.name);
        userRow.set('Time Out', timestamp);
        userRow.set('Location', officeName);
        await userRow.save();
        console.log('✅ Row updated with Time Out');
        console.log(`📤 Sending clock-out confirmation to ${from}`);
        await sendMessage(from, `Clocked out successfully at ${timestamp} at ${officeName}.`);
        console.log('✅ Clock-out message sent');
      }
    }
  } catch (error) {
    console.error('❌ Clock action failed:', error.message);
  }

  userStates.delete(from);
}
         res.sendStatus(200);
       } else {
         res.sendStatus(404);
       }
     });

     // Send WhatsApp reply
             async function sendMessage(to, text) {
            console.log(`📤 Sending to ${to}: "${text.substring(0, 50)}..."`);
            const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
            const data = {
              messaging_product: 'whatsapp',
              to: to,
              type: 'text',
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
         // Don't throw—let the app continue
  }
}
    // Health check endpoint (add if missing)
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

















