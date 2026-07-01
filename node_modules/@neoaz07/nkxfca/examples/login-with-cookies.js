#!/usr/bin/env node
"use strict";

/**
 * Example: Login with Cookie Array
 * 
 * This demonstrates how to login to Facebook Chat API using a cookie array
 * instead of email/password credentials.
 * 
 * Cookie Format:
 * - Array of objects with 'name' (or 'key') and 'value' properties
 * - Extracted from browser cookies or previous session
 */

const login = require('../index.js');

// Method 1: Cookie Array with 'name' property
const cookieArray = [
    {
        name: 'c_user',
        value: 'YOUR_USER_ID_HERE'
    },
    {
        name: 'xs',
        value: 'YOUR_XS_TOKEN_HERE'
    },
    {
        name: 'fr',
        value: 'YOUR_FR_TOKEN_HERE'
    },
    {
        name: 'datr',
        value: 'YOUR_DATR_TOKEN_HERE'
    }
];

// Method 2: Cookie Array with 'key' property (alternative)
const cookieArrayAlt = [
    {
        key: 'c_user',
        value: 'YOUR_USER_ID_HERE'
    },
    {
        key: 'xs',
        value: 'YOUR_XS_TOKEN_HERE'
    }
];

// Method 3: Cookie String format (semicolon-separated)
const cookieString = 'c_user=YOUR_USER_ID_HERE; xs=YOUR_XS_TOKEN_HERE; fr=YOUR_FR_TOKEN_HERE; datr=YOUR_DATR_TOKEN_HERE';

/**
 * Login using cookie array
 */
async function loginWithCookies() {
    try {
        const api = await login.login({
            appState: cookieArray // Pass the cookie array here
        }, {
            logging: true,
            listenEvents: true,
            autoMarkRead: true,
            selfListen: false
        });

        console.log('✓ Successfully logged in using cookies!');
        console.log('✓ User ID:', api.getCurrentUserID());

        // Now you can use the API normally
        // Example: Send a message
        // api.sendMessage("Hello World!", threadID);

        // Clean up
        api.stopListening();
        process.exit(0);

    } catch (error) {
        console.error('✗ Login failed:', error.message);
        process.exit(1);
    }
}

/**
 * How to extract cookies from your browser:
 * 
 * 1. Open Facebook in your browser
 * 2. Open Developer Tools (F12)
 * 3. Go to Application → Cookies → facebook.com
 * 4. Copy the critical cookies:
 *    - c_user: Your user ID
 *    - xs: Session token
 *    - fr: Fraud detection
 *    - datr: Device fingerprint
 * 
 * 5. Replace the values in cookieArray above
 * 6. Run: node examples/login-with-cookies.js
 */

// Uncomment to run:
// loginWithCookies();

module.exports = { loginWithCookies, cookieArray };
