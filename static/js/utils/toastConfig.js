// PP-GUI-FIX: single source of toastr behaviour for the map page.
// 1) preventDuplicates collapses identical toasts fired in quick succession
//    (defence-in-depth against any remaining multi-fire path).
// 2) swipe-to-dismiss lets the user flick a toast away horizontally.
(function () {
    if (typeof window === 'undefined' || !window.toastr) {
        return;
    }

    window.toastr.options = Object.assign({}, window.toastr.options, {
        closeButton: true,
        progressBar: true,
        preventDuplicates: true,
        newestOnTop: true,
        positionClass: 'toast-top-right',
        timeOut: 5000,
        extendedTimeOut: 2000,
        showDuration: 200,
        hideDuration: 250
    });

    // --- swipe-to-dismiss ------------------------------------------------
    var SWIPE_DISMISS_PX = 60;   // distance past which the toast is removed
    var DRAG_START_PX = 8;       // ignore micro-movements / taps
    var FADE_OUT_PX = 220;       // distance over which opacity reaches 0
    var active = null;           // { el, startX, startY, dx, dragging }

    function toastElement(target) {
        if (!target || !target.closest) {
            return null;
        }
        return target.closest('#toast-container > div');
    }

    function pointFrom(e) {
        return e.touches && e.touches[0] ? e.touches[0] : e;
    }

    function removeToast(el) {
        if (window.jQuery && window.toastr && typeof window.toastr.clear === 'function') {
            window.toastr.clear(window.jQuery(el));
        }
        // Fallback / guarantee removal even if toastr lost track of the node.
        if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
    }

    function onDown(e) {
        var el = toastElement(e.target);
        if (!el) {
            return;
        }
        var p = pointFrom(e);
        active = { el: el, startX: p.clientX, startY: p.clientY, dx: 0, dragging: false };
        el.style.transition = 'none';
    }

    function onMove(e) {
        if (!active) {
            return;
        }
        var p = pointFrom(e);
        var dx = p.clientX - active.startX;
        var dy = p.clientY - active.startY;
        if (!active.dragging) {
            // only start dragging on a clearly horizontal gesture
            if (Math.abs(dx) < DRAG_START_PX || Math.abs(dx) <= Math.abs(dy)) {
                return;
            }
            active.dragging = true;
        }
        active.dx = dx;
        active.el.style.transform = 'translateX(' + dx + 'px)';
        active.el.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / FADE_OUT_PX));
        if (e.cancelable) {
            e.preventDefault();
        }
    }

    function onUp() {
        if (!active) {
            return;
        }
        var el = active.el;
        var dx = active.dx;
        var dragging = active.dragging;
        active = null;
        if (!dragging) {
            return;
        }
        if (Math.abs(dx) >= SWIPE_DISMISS_PX) {
            var direction = dx > 0 ? 1 : -1;
            el.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
            el.style.transform = 'translateX(' + (direction * 500) + 'px)';
            el.style.opacity = '0';
            window.setTimeout(function () { removeToast(el); }, 200);
        } else {
            // snap back into place
            el.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
            el.style.transform = 'translateX(0)';
            el.style.opacity = '1';
        }
    }

    document.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchstart', onDown, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
})();
