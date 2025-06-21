window.onload = async function() {
    // Check if the browser supports the necessary APIs
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Your browser does not support the necessary features for eye tracking.");
        return;
    }

    const gazeDot = document.getElementById('gaze-dot');

    // Start WebGazer
    await webgazer.setRegression('ridge') /* Ridge regression is a good default */
        .setGazeListener(function(data, elapsedTime) {
            // Log the data to the console for debugging
            console.log('Gaze data:', data);

            if (data == null) {
                return;
            }
            // data.x gives the x coordinate of the gaze
            // data.y gives the y coordinate of the gaze
            var xprediction = data.x;
            var yprediction = data.y;

            // Move the red dot to the predicted gaze location
            gazeDot.style.left = xprediction + 'px';
            gazeDot.style.top = yprediction + 'px';

        }).begin();

    // These settings are helpful for debugging and seeing what WebGazer is doing.
    webgazer.showPredictionPoints(true); /* Shows a green point on the video feed */
    webgazer.showVideo(true); /* Shows the webcam video feed */
};

// A safety measure to pause the script if the user closes the window or navigates away
window.onbeforeunload = function() {
    webgazer.end();
}; 