
     // Load tools – like getting ingredients for a recipe
     const express = require('express'); // Handles WhatsApp messages
     //const { GoogleSpreadsheet } = require('google-spreadsheet'); // Connects to sheets
   (async () => {
  const { GoogleSpreadsheet } = await import('google-spreadsheet');
  global.GoogleSpreadsheet = GoogleSpreadsheet;
  // Now start your server
 // require('./server'); // or whatever starts your Express app
})();
     const { JWT } = require('google-auth-library'); // Logs into Google
     const axios = require('axios'); // Sends WhatsApp replies
     require('dotenv').config(); // Loads .env secrets

     // Create app – like starting a machine
     const app = express();
     app.use(express.json()); // Understands WhatsApp message format

     // Set port – where app listens on VPS
     const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('App is running!');
});

     // Get secrets from .env
     const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
     const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
     const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

     // Office locations – replace with yours from Step 2
     const OFFICE_LOCATIONS = [
       { name: 'Head_Office', lat: 9.429241474535132, long: -1.0533786340817441, radius: 0.5 }, // REPLACE
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
     const serviceAccountAuth = new JWT({
       email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
       key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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
       const body = req.body;
       if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
         const message = body.entry[0].changes[0].value.messages[0];
         const from = message.from;

         // Check Staff sheet
         const staffDoc = new GoogleSpreadsheet(process.env.STAFF_SHEET_ID, serviceAccountAuth);
         await staffDoc.loadInfo();
         const staffSheet = staffDoc.sheetsByIndex[0];
         const staffRows = await staffSheet.getRows();
         const user = staffRows.find(row => row.get('Phone') === `+${from}`);

         if (!user) {
           await sendMessage(from, 'Unauthorized user.');
           return res.sendStatus(200);
         }

         if (message.type === 'text') {
           const text = message.text.body.toLowerCase();
           if (text === 'clock in' || text === 'clock out') {
             userStates.set(from, { action: text, name: user.get('Name'), department: user.get('Department') });
             await sendMessage(from, `Please share your location to confirm ${text}.`);
           }
         } else if (message.type === 'location') {
           const { latitude, longitude } = message.location;
           const officeName = getOfficeName(latitude, longitude);
           if (!officeName) {
             await sendMessage(from, 'Location not at any office. Try again.');
             return res.sendStatus(200);
           }

           const userState = userStates.get(from);
           if (!userState) {
             await sendMessage(from, 'Please send "clock in" or "clock out" first.');
             return res.sendStatus(200);
           }

           const timestamp = new Date().toISOString();
           const attendanceDoc = new GoogleSpreadsheet(process.env.ATTENDANCE_SHEET_ID, serviceAccountAuth);
           await attendanceDoc.loadInfo();
           const attendanceSheet = attendanceDoc.sheetsByIndex[0];

           const dateStr = timestamp.split('T')[0];
           const rows = await attendanceSheet.getRows();
           let userRow = rows.find(row => row.get('Phone') === `+${from}` && row.get('Time In')?.startsWith(dateStr));

           if (userState.action === 'clock in') {
             if (userRow && userRow.get('Time In')) {
               await sendMessage(from, 'You already clocked in today.');
             } else {
               await attendanceSheet.addRow({
                 Name: userState.name,
                 Phone: `+${from}`,
                 'Time In': timestamp,
                 'Time Out': '',
                 Location: officeName,
                 Department: userState.department
               });
               await sendMessage(from, `Clocked in successfully at ${timestamp} at ${officeName}.`);
             }
           } else if (userState.action === 'clock out') {
             if (!userRow || !userRow.get('Time In')) {
               await sendMessage(from, 'No clock-in record found for today.');
             } else if (userRow.get('Time Out')) {
               await sendMessage(from, 'You already clocked out today.');
             } else {
               userRow.set('Time Out', timestamp);
               userRow.set('Location', officeName);
               await userRow.save();
               await sendMessage(from, `Clocked out successfully at ${timestamp} at ${officeName}.`);
             }
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
       const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
       const data = {
         messaging_product: 'whatsapp',
         to: to,
         type: 'text',
         text: { body: text }
       };
       await axios.post(url, data, {
         headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
       });
     }

     // Start app on VPS
     app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    
