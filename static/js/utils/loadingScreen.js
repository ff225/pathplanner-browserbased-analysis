async function show(document, message = 'Calculating optimal route, please wait...') {
    // Check if loading overlay already exists
    if (document.getElementById('loadingOverlay')) {
        return; // Avoid creating multiple overlays
    }
    
    var loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'loadingOverlay';
    loadingOverlay.style.position = 'fixed';
    loadingOverlay.style.top = '0';
    loadingOverlay.style.left = '0';
    loadingOverlay.style.width = '100%';
    loadingOverlay.style.height = '100%';
    loadingOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
    loadingOverlay.style.backdropFilter = 'blur(10px)';
    loadingOverlay.style.webkitBackdropFilter = 'blur(10px)';
    loadingOverlay.style.display = 'flex';
    loadingOverlay.style.flexDirection = 'column';
    loadingOverlay.style.alignItems = 'center';
    loadingOverlay.style.justifyContent = 'center';
    loadingOverlay.style.zIndex = '9999';
    loadingOverlay.style.transition = 'opacity 0.3s ease-in-out';
    loadingOverlay.style.opacity = '0';
    
    // Create a container for the spinner and message
    const container = document.createElement('div');
    container.style.textAlign = 'center';
    
    // Create spinner element
    const spinner = document.createElement('div');
    spinner.style.width = '60px';
    spinner.style.height = '60px';
    spinner.style.margin = '0 auto 20px';
    spinner.style.border = '4px solid rgba(255, 255, 255, 0.3)';
    spinner.style.borderTop = '4px solid #ffffff';
    spinner.style.borderRadius = '50%';
    spinner.style.animation = 'spin 1s linear infinite';
    
    // Create message element
    const messageElement = document.createElement('div');
    messageElement.style.color = 'white';
    messageElement.style.fontSize = '20px';
    messageElement.style.fontWeight = '500';
    messageElement.style.lineHeight = '1.5';
    messageElement.innerHTML = message;
    
    // Create progress indicator text
    const progressElement = document.createElement('div');
    progressElement.style.color = 'rgba(255, 255, 255, 0.8)';
    progressElement.style.fontSize = '14px';
    progressElement.style.marginTop = '10px';
    progressElement.innerHTML = 'Analyzing route conditions...';
    
    // Add CSS animation for spinner
    if (!document.getElementById('loadingSpinnerStyles')) {
        const style = document.createElement('style');
        style.id = 'loadingSpinnerStyles';
        style.textContent = `
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            @keyframes pulse {
                0%, 100% { opacity: 0.8; }
                50% { opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Assemble the components
    container.appendChild(spinner);
    container.appendChild(messageElement);
    container.appendChild(progressElement);
    loadingOverlay.appendChild(container);
    
    document.body.appendChild(loadingOverlay);
    
    // Fade in the overlay
    setTimeout(() => {
        loadingOverlay.style.opacity = '1';
    }, 10);
    
    // Update progress messages periodically
    let messageIndex = 0;
    const progressMessages = [
        'Analyzing route conditions...',
        'Evaluating environmental factors...',
        'Calculating optimal path...',
        'Checking accessibility features...',
        'Optimizing for your preferences...',
        'Finalizing route details...'
    ];
    
    const progressInterval = setInterval(() => {
        if (!document.getElementById('loadingOverlay')) {
            clearInterval(progressInterval);
            return;
        }
        messageIndex = (messageIndex + 1) % progressMessages.length;
        progressElement.innerHTML = progressMessages[messageIndex];
    }, 2000);
    
    // Store the interval ID so we can clear it when hiding
    loadingOverlay.dataset.intervalId = progressInterval;
}

async function hide(document) {
    var loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
        // Clear the progress interval if it exists
        const intervalId = loadingOverlay.dataset.intervalId;
        if (intervalId) {
            clearInterval(intervalId);
        }
        
        // Fade out the overlay
        loadingOverlay.style.opacity = '0';
        
        // Remove after fade out animation
        setTimeout(() => {
            if (loadingOverlay && loadingOverlay.parentNode) {
                loadingOverlay.remove();
            }
        }, 300);
    }
}

export {
    show,
    hide
}