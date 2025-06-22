// The 'FaceMesh' and 'Camera' classes are now automatically available in the global scope from the scripts in the HTML.
// No need for import statements.

console.log("Script loaded successfully.");

// --- App State ---
let state = 'IDLE'; // IDLE, CROP_ADJUSTMENT, GAZE_CALIBRATION, SESSION_STARTING, RUNNING
let latestIrisPosition = null;
let calibratedIrisPosition = null;
let xOffset = 0;
let yOffset = 0;

// --- Live Session State ---
let dotPosition = { x: null, y: null }; // Smoothed position
let tailPositions = []; // Array to store recent positions for the tail
const SMOOTHING_FACTOR = 0.1;
const TAIL_LENGTH = 90; // Approx 3 seconds at 30fps
const SNAP_RADIUS = 7; // In pixels
let timerInterval = null;
let sessionStartTime = 0;
let timeInZone = 0;
let totalSessionTime = 0;
let sessionHistory = []; // To store all dot positions for the heatmap

// --- Settings ---
let snapRadius = 20;
let brightness = 100;
let contrast = 200;
let blockSize = 4;
let ditherAlgorithm = 'atkinson';
const baseGazeVelocity = 5; // The scaleFactor corresponding to 150%

// --- DOM Elements ---
const canvasElement = document.getElementById('output_canvas');
const videoElement = document.getElementById('input_video');
const canvasCtx = canvasElement.getContext('2d');
const instructionsEl = document.getElementById('instructions');
const cropControlsEl = document.getElementById('crop-controls');
const confirmCropButton = document.getElementById('confirm-crop-button');
const gazeCalibrationOverlay = document.getElementById('gaze-calibration-overlay');
const sessionStartOverlay = document.getElementById('session-start-overlay');
const timerEl = document.getElementById('timer');
const sessionSummaryOverlay = document.getElementById('session-summary-overlay');
const summaryStatsEl = document.getElementById('summary-stats');
const resetButton = document.getElementById('reset-button');
const readyButton = document.getElementById('ready-button');
const xOffsetSlider = document.getElementById('x-offset-slider');
const yOffsetSlider = document.getElementById('y-offset-slider');
const heatmapCanvas = document.getElementById('heatmap_canvas');

// Settings Panel Elements
const targetZoneInput = document.getElementById('target-zone-size');
const brightnessInput = document.getElementById('brightness');
const contrastInput = document.getElementById('contrast');
const blockSizeInput = document.getElementById('block-size');
const ditherAlgorithmInput = document.getElementById('dither-algorithm');
const difficultyRatingEl = document.getElementById('difficulty-rating');

const tempCanvas = document.createElement('canvas');
const tempCtx = tempCanvas.getContext('2d');

const CROP_SIZE_PX = 400;

function applyDither(ctx, width, height) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const gray = new Uint8ClampedArray(imageData.data.length / 4);
    for (let i = 0; i < imageData.data.length; i += 4) {
        gray[i / 4] = 0.299 * imageData.data[i] + 0.587 * imageData.data[i+1] + 0.114 * imageData.data[i+2];
    }

    const dithered = new Uint8ClampedArray(gray.length);
    const errors = new Float32Array(gray.length).fill(0);

    // This is where the different algorithms will be called
    if (ditherAlgorithm === 'bayer') {
        applyBayerDither(gray, dithered, width, height);
    } else { // Error diffusion algorithms
        applyErrorDiffusionDither(gray, dithered, errors, width, height);
    }

    // 3. Draw the dithered result as dots on the main canvas
    canvasCtx.fillStyle = '#FFFFFF';
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (dithered[y * width + x] > 128) { // If pixel is white
                canvasCtx.beginPath();
                canvasCtx.rect(x * blockSize, y * blockSize, blockSize, blockSize);
                canvasCtx.fill();
            }
        }
    }
}

function applyErrorDiffusionDither(gray, dithered, errors, width, height) {
    const matrixDetails = {
        'jarvis': {
            divisor: 48,
            matrix: [
                { x: 1, y: 0, w: 7 }, { x: 2, y: 0, w: 5 },
                { x: -2, y: 1, w: 3 }, { x: -1, y: 1, w: 5 }, { x: 0, y: 1, w: 7 }, { x: 1, y: 1, w: 5 }, { x: 2, y: 1, w: 3 },
                { x: -2, y: 2, w: 1 }, { x: -1, y: 2, w: 3 }, { x: 0, y: 2, w: 5 }, { x: 1, y: 2, w: 3 }, { x: 2, y: 2, w: 1 }
            ],
            yLimit: height - 2, xStart: 2, xLimit: width - 2
        },
        'floyd': {
            divisor: 16,
            matrix: [
                { x: 1, y: 0, w: 7 },
                { x: -1, y: 1, w: 3 }, { x: 0, y: 1, w: 5 }, { x: 1, y: 1, w: 1 }
            ],
            yLimit: height - 1, xStart: 1, xLimit: width - 1
        },
        'atkinson': {
            divisor: 8,
            matrix: [
                { x: 1, y: 0, w: 1 }, { x: 2, y: 0, w: 1 },
                { x: -1, y: 1, w: 1 }, { x: 0, y: 1, w: 1 }, { x: 1, y: 1, w: 1 },
                { x: 0, y: 2, w: 1 }
            ],
            yLimit: height - 2, xStart: 1, xLimit: width - 2
        }
    };

    const config = matrixDetails[ditherAlgorithm];

    for (let y = 0; y < config.yLimit; y++) {
        for (let x = config.xStart; x < config.xLimit; x++) {
            const index = y * width + x;
            const oldPixel = gray[index] + errors[index];
            const newPixel = oldPixel < 128 ? 0 : 255;
            dithered[index] = newPixel;
            const quantError = oldPixel - newPixel;

            for (const p of config.matrix) {
                errors[index + p.x + (p.y * width)] += quantError * p.w / config.divisor;
            }
        }
    }
}

function applyBayerDither(gray, dithered, width, height) {
    const bayerMatrix = [
        [  0, 128,  32, 160 ],
        [ 192,  64, 224,  96 ],
        [  48, 176,  16, 144 ],
        [ 240, 112, 208,  80 ]
    ];
    const matrixSize = 4;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            const threshold = bayerMatrix[y % matrixSize][x % matrixSize];
            dithered[index] = gray[index] < threshold ? 0 : 255;
        }
    }
}

function onResults(results) {
    if (!videoElement.videoWidth) return;

    canvasElement.width = CROP_SIZE_PX;
    canvasElement.height = CROP_SIZE_PX;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];

        // --- Crop Calculation ---
        let minX = 1.0, maxX = 0.0, minY = 1.0, maxY = 0.0;
        for (const point of FACEMESH_RIGHT_EYE) {
            const landmark = landmarks[point[0]];
            if (landmark.x < minX) minX = landmark.x;
            if (landmark.x > maxX) maxX = landmark.x;
            if (landmark.y < minY) minY = landmark.y;
            if (landmark.y > maxY) maxY = landmark.y;
        }
        let width = maxX - minX;
        let padding = width * 0.5;
        minX -= padding;
        minY -= padding;
        let size = Math.max(maxX - minX, maxY - minY);
        let centerX = minX + (maxX - minX) / 2;
        let centerY = minY + (maxY - minY) / 2;
        minX = centerX - size / 2;
        minY = centerY - size / 2;
        
        const sx = (minX * results.image.width) + xOffset;
        const sy = (minY * results.image.height) + yOffset;
        const sWidth = size * results.image.width;
        const sHeight = size * results.image.height;
        
        // --- Visual Effects Pipeline ---
        // Clear the main canvas before drawing
        canvasCtx.clearRect(0, 0, CROP_SIZE_PX, CROP_SIZE_PX);

        // 1. Draw original video to a low-res temp canvas for processing
        const processWidth = CROP_SIZE_PX / blockSize;
        const processHeight = CROP_SIZE_PX / blockSize;
        tempCanvas.width = processWidth;
        tempCanvas.height = processHeight;

        tempCtx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
        tempCtx.drawImage(results.image, sx, sy, sWidth, sHeight, 0, 0, processWidth, processHeight);

        // 2. Apply chosen dither algorithm to the low-res temp canvas
        if (state !== 'IDLE') {
            applyDither(tempCtx, processWidth, processHeight);
        }

        // Reset filter so it doesn't affect UI drawn later (crosshair, dot)
        canvasCtx.filter = 'none';

        // --- Iris Position Calculation ---
        let irisCenterX = 0, irisCenterY = 0;
        for (const point of FACEMESH_RIGHT_IRIS) {
            irisCenterX += landmarks[point[0]].x;
            irisCenterY += landmarks[point[0]].y;
        }
        irisCenterX /= FACEMESH_RIGHT_IRIS.length;
        irisCenterY /= FACEMESH_RIGHT_IRIS.length;
        
        latestIrisPosition = {
            x: (irisCenterX - minX) / size,
            y: (irisCenterY - minY) / size
        };
        
        // --- Drawing for CROP_ADJUSTMENT state ---
        if (state === 'CROP_ADJUSTMENT') {
            // Draw a central "locus" point as a white crosshair
            const centerX = CROP_SIZE_PX / 2;
            const centerY = CROP_SIZE_PX / 2;
            const crosshairSize = snapRadius; 
            canvasCtx.beginPath();
            canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            canvasCtx.lineWidth = 2;
            // Horizontal line
            canvasCtx.moveTo(centerX - crosshairSize, centerY);
            canvasCtx.lineTo(centerX + crosshairSize, centerY);
            // Vertical line
            canvasCtx.moveTo(centerX, centerY - crosshairSize);
            canvasCtx.lineTo(centerX, centerY + crosshairSize);
            canvasCtx.stroke();
        }

        // --- Drawing for RUNNING state ---
        if (state === 'RUNNING') {
            const centerX = CROP_SIZE_PX / 2;
            const centerY = CROP_SIZE_PX / 2;

            // Initialize dot position to the center if it's the first frame
            if (dotPosition.x === null) {
                dotPosition.x = centerX;
                dotPosition.y = centerY;
            }
            
            // --- New Movement Logic ---
            const rawDeviationX = (latestIrisPosition.x - calibratedIrisPosition.x) * CROP_SIZE_PX * 5;
            const rawDeviationY = (latestIrisPosition.y - calibratedIrisPosition.y) * CROP_SIZE_PX * 5;
            const deviationDist = Math.sqrt(rawDeviationX**2 + rawDeviationY**2);
            
            let targetX, targetY;
            const maxDotDist = 200 - 8; // Canvas radius minus dot radius

            if (deviationDist < snapRadius) {
                targetX = centerX;
                targetY = centerY;
                if (state === 'RUNNING') timeInZone += 1 / 30; // Assuming ~30fps
            } else {
                const triggerDist = snapRadius * 3;
                const deviationAngle = Math.atan2(rawDeviationY, rawDeviationX);
                let dotDist;

                if (deviationDist >= triggerDist) {
                    dotDist = maxDotDist;
                } else {
                    // Interpolate dot's distance based on eye's distance
                    const progress = (deviationDist - snapRadius) / (triggerDist - snapRadius);
                    dotDist = snapRadius + progress * (maxDotDist - snapRadius);
                }
                
                targetX = centerX + Math.cos(deviationAngle) * dotDist;
                targetY = centerY + Math.sin(deviationAngle) * dotDist;
            }
            
            // 3. Apply Smoothing (Velocity)
            dotPosition.x += (targetX - dotPosition.x) * SMOOTHING_FACTOR;
            dotPosition.y += (targetY - dotPosition.y) * SMOOTHING_FACTOR;

            // 4. Calculate Dot Color based on distance
            let hue = 0; // Default to red
            const colorDistance = Math.sqrt(Math.pow(dotPosition.x - centerX, 2) + Math.pow(dotPosition.y - centerY, 2));
            if (colorDistance > snapRadius) {
                const maxDist = snapRadius * 2; // Point at which color is fully blue
                const normalizedDist = Math.min((colorDistance - snapRadius) / (maxDist - snapRadius), 1.0);
                hue = normalizedDist * 240; // 0 is red, 240 is blue
            }
            const dotColor = `hsl(${hue}, 100%, 50%)`;

            // 5. Update and Draw Tail
            tailPositions.push({ x: dotPosition.x, y: dotPosition.y, color: dotColor });
            if (tailPositions.length > TAIL_LENGTH) {
                tailPositions.shift();
            }
            // Store history for heatmap
            sessionHistory.push({ x: dotPosition.x, y: dotPosition.y });

            // Draw the tail
            for (let i = 0; i < tailPositions.length; i++) {
                const pos = tailPositions[i];
                const opacity = (i / tailPositions.length) * 0.5; // Max opacity of 50%
                
                // Manually parse HSLA from the stored HSL color string
                const baseColor = pos.color.replace('hsl', 'hsla').replace(')', `, ${opacity})`);

                canvasCtx.beginPath();
                canvasCtx.arc(pos.x, pos.y, 8, 0, 2 * Math.PI);
                canvasCtx.fillStyle = baseColor;
                canvasCtx.fill();
            }

            // 6. Draw the main gaze dot
            canvasCtx.beginPath();
            canvasCtx.arc(dotPosition.x, dotPosition.y, 8, 0, 2 * Math.PI);
            canvasCtx.fillStyle = dotColor;
            canvasCtx.fill();

            // 7. Draw the central crosshair (drawn last to be on top)
            const crosshairSize = snapRadius;
            canvasCtx.beginPath();
            canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            canvasCtx.lineWidth = 2;
            // Horizontal line
            canvasCtx.moveTo(centerX - crosshairSize, centerY);
            canvasCtx.lineTo(centerX + crosshairSize, centerY);
            // Vertical line
            canvasCtx.moveTo(centerX, centerY - crosshairSize);
            canvasCtx.lineTo(centerX, centerY + crosshairSize);
            canvasCtx.stroke();
        }
    } else {
        canvasCtx.fillStyle = "white";
        canvasCtx.font = "20px sans-serif";
        canvasCtx.textAlign = "center";
        canvasCtx.fillText("Waiting for face...", CROP_SIZE_PX / 2, CROP_SIZE_PX / 2);
    }
    canvasCtx.restore();
}

// --- State Transition & Event Listeners ---
function handleMainInteraction() {
    switch (state) {
        case 'IDLE':
            state = 'CROP_ADJUSTMENT';
            instructionsEl.classList.add('hidden');
            canvasElement.classList.remove('hidden');
            canvasElement.classList.add('calibrating-crop');
            cropControlsEl.classList.remove('hidden');
            resetButton.classList.remove('hidden');
            break;

        case 'GAZE_CALIBRATION':
            if (!latestIrisPosition) return;
            calibratedIrisPosition = latestIrisPosition;
            gazeCalibrationOverlay.classList.add('hidden');
            
            state = 'SESSION_STARTING';
            sessionStartOverlay.classList.remove('hidden');
            
            setTimeout(() => {
                state = 'RUNNING';
                sessionStartOverlay.classList.add('hidden');
                // Reset live session state variables for a new session
                dotPosition = { x: null, y: null };
                tailPositions = [];
                sessionHistory = [];
                startTimer();
                console.log("Calibration complete. Calibrated center:", calibratedIrisPosition);
            }, 3000); // Shortened for quicker testing
            break;
        
        case 'RUNNING':
            stopTimer();
            state = 'SESSION_ENDED';
            canvasElement.classList.add('hidden');
            timerEl.classList.add('hidden');
            resetButton.classList.add('hidden');
            
            drawHeatmap();

            const percentageInZone = totalSessionTime > 0 ? (timeInZone / totalSessionTime) * 100 : 0;
            const difficulty = difficultyRatingEl.textContent;
            const score = calculateScore(totalSessionTime, percentageInZone, difficulty);

            summaryStatsEl.innerHTML = `
                DURATION: ${formatTime(Math.round(totalSessionTime))}<br>
                IN-ZONE: ${percentageInZone.toFixed(0)}%<br>
                DIFFICULTY RATING: ${difficulty}<br><br>
                SCORE: ${score}
            `;
            sessionSummaryOverlay.classList.remove('hidden');
            break;

        case 'SESSION_ENDED':
            window.location.reload();
            break;
    }
}

document.addEventListener('click', handleMainInteraction);
document.addEventListener('touchstart', handleMainInteraction);

function handleReadyClick() {
    if (state !== 'CROP_ADJUSTMENT') return;

    state = 'GAZE_CALIBRATION';
    cropControlsEl.classList.add('hidden');
    canvasElement.classList.remove('calibrating-crop');
    gazeCalibrationOverlay.classList.remove('hidden');
}
readyButton.addEventListener('click', handleReadyClick);
readyButton.addEventListener('touchstart', handleReadyClick);

function drawHeatmap() {
    const heatmapCtx = heatmapCanvas.getContext('2d');
    heatmapCanvas.width = CROP_SIZE_PX;
    heatmapCanvas.height = CROP_SIZE_PX;

    // Create a density map
    const density = {};
    const grid_size = 10; // The size of the grid cells for density calculation
    let max_density = 0;

    for (const pos of sessionHistory) {
        const gridX = Math.floor(pos.x / grid_size);
        const gridY = Math.floor(pos.y / grid_size);
        const key = `${gridX},${gridY}`;
        density[key] = (density[key] || 0) + 1;
        if (density[key] > max_density) {
            max_density = density[key];
        }
    }

    // Function to map a value to a color in a gradient
    function getColorForValue(value){
        const h = (1.0 - value) * 240;
        return "hsl(" + h + ", 100%, 50%)";
    }

    // Draw the heatmap circles
    heatmapCtx.globalAlpha = 0.3; // low alpha for blending
    for (const pos of sessionHistory) {
        const gridX = Math.floor(pos.x / grid_size);
        const gridY = Math.floor(pos.y / grid_size);
        const key = `${gridX},${gridY}`;
        const normalized_density = density[key] / max_density;
        
        heatmapCtx.beginPath();
        heatmapCtx.fillStyle = getColorForValue(normalized_density);
        heatmapCtx.arc(pos.x, pos.y, 15, 0, 2 * Math.PI);
        heatmapCtx.fill();
    }
    heatmapCtx.globalAlpha = 1.0;

    // Overlay the dithered dots for texture
    const ditherDotSize = blockSize > 1 ? blockSize / 2 : 1;
    heatmapCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (const pos of sessionHistory) {
        if (Math.random() > 0.5) { // Thin out the dots a bit
            heatmapCtx.beginPath();
            heatmapCtx.rect(pos.x - ditherDotSize / 2, pos.y - ditherDotSize / 2, ditherDotSize, ditherDotSize);
            heatmapCtx.fill();
        }
    }
}

function calculateScore(duration, inZonePercentage, difficulty) {
    // 1. Duration component (up to 40 points)
    // Max score at 30 minutes (1800 seconds)
    const durationComponent = Math.min(duration / 1800, 1) * 40;

    // 2. In-Zone component (up to 40 points)
    const inZoneComponent = (inZonePercentage / 100) * 40;

    // 3. Difficulty component (up to 20 points)
    const difficultyMap = { "Noob": 1, "Student": 4, "Adept": 10, "Expert": 15, "Guru": 20 };
    const difficultyComponent = difficultyMap[difficulty] || 0;

    const totalScore = Math.round(durationComponent + inZoneComponent + difficultyComponent);
    return Math.min(totalScore, 100); // Ensure score doesn't exceed 100
}

function startTimer() {
    sessionStartTime = Date.now();
    timeInZone = 0;
    totalSessionTime = 0;
    timerEl.classList.remove('hidden');

    timerInterval = setInterval(() => {
        totalSessionTime = (Date.now() - sessionStartTime) / 1000;
        timerEl.textContent = formatTime(Math.round(totalSessionTime));
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
}

function formatTime(seconds) {
    const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function handleResetClick(event) {
    event.stopPropagation(); // Prevent the main click listener from firing
    window.location.reload();
}
resetButton.addEventListener('click', handleResetClick);
resetButton.addEventListener('touchstart', handleResetClick);

// --- Settings Listeners ---
targetZoneInput.addEventListener('input', (e) => {
    snapRadius = parseInt(e.target.value) || 0;
    if (snapRadius < 1) snapRadius = 1;
    if (snapRadius > 50) snapRadius = 50;
    updateDifficultyRating();
});
brightnessInput.addEventListener('input', (e) => {
    brightness = parseFloat(e.target.value) || 100;
});
contrastInput.addEventListener('input', (e) => {
    contrast = parseFloat(e.target.value) || 100;
});
blockSizeInput.addEventListener('input', (e) => {
    blockSize = parseFloat(e.target.value) || 1;
    if (blockSize < 1) blockSize = 1;
});
ditherAlgorithmInput.addEventListener('input', (e) => {
    ditherAlgorithm = e.target.value;
});

function updateDifficultyRating() {
    let rating = "Noob";
    if (snapRadius < 10) rating = "Guru";
    else if (snapRadius < 15) rating = "Expert";
    else if (snapRadius < 25) rating = "Adept";
    else if (snapRadius <= 35) rating = "Student";

    difficultyRatingEl.textContent = rating;
}

xOffsetSlider.addEventListener('input', (event) => xOffset = parseInt(event.target.value, 10));
yOffsetSlider.addEventListener('input', (event) => yOffset = parseInt(event.target.value, 10));

// --- MediaPipe Setup ---
const faceMesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
faceMesh.onResults(onResults);
const camera = new Camera(videoElement, {
    onFrame: async () => await faceMesh.send({ image: videoElement }),
    width: 1280,
    height: 720,
    facingMode: 'user' // Use the front camera on mobile
});
camera.start();
console.log("Camera start command issued.");
updateDifficultyRating(); // Set initial rating 