const API_URL = 'https://airquality.googleapis.com/v1/currentConditions:lookup?key=';
const API_KEY = 'AIzaSyC0TVjFQtQPkYjKC8nXuXUrPneKb1AZnDc';
const DEFAULT_AQI = 3;

export async function get(lat, long) {
    try {
        const response = await fetch(`${API_URL}${API_KEY}`, {
            method: 'POST',
            body: JSON.stringify({
                location: {
                    latitude: lat,
                    longitude: long
                },
                universalAqi: true
            })
        });
    
        if (!response.ok) {
            throw new Error(`Google AQI error: ${await response.json().error.message}`);
        }

        const data = await response.json();
        return {
            airQuality: Math.floor(data.indexes[0].aqi/10),
            timestamp: new Date().toLocaleString()
        }
    } catch (error) {
        console.warn('Error getting AQI from Google:', error);
        return {
            airQuality: DEFAULT_AQI,
            timestamp: new Date().toLocaleString()
        }
    }
}