// ================= GLOBAL SIDEBAR SCRIPT =================

(function() {
    'use strict';

    // Elements
    const sidebar = document.getElementById('globalSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const toggleBtn = document.getElementById('toggleSidebarBtn');
    const closeBtn = document.getElementById('closeSidebar');

    if (!sidebar || !overlay || !toggleBtn) {
        console.warn('Sidebar elements not found');
        return;
    }

    // Open Sidebar
    function openSidebar() {
        sidebar.classList.remove('collapsed');
        overlay.classList.add('active');
        document.body.classList.add('sidebar-open');
        document.body.classList.toggle("sidebar-collapsed");
        
        // Save state
        sessionStorage.setItem('sidebarOpen', 'true');
    }

    // Close Sidebar
    function closeSidebar() {
        sidebar.classList.add('collapsed');
        overlay.classList.remove('active');
        document.body.classList.remove('sidebar-open');
        
        // Save state
        sessionStorage.setItem('sidebarOpen', 'false');
    }

    // Toggle Sidebar
    function toggleSidebar() {
        if (sidebar.classList.contains('collapsed')) {
            openSidebar();
        } else {
            closeSidebar();
        }
    }

    // Event Listeners
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleSidebar);
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeSidebar);
    }

    if (overlay) {
        overlay.addEventListener('click', closeSidebar);
    }

    // Keyboard shortcut: ESC to close
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && !sidebar.classList.contains('collapsed')) {
            closeSidebar();
        }
    });

    // Restore sidebar state from previous session (optional)
    const savedState = sessionStorage.getItem('sidebarOpen');
    if (savedState === 'true') {
        openSidebar();
    }

    console.log('✅ Global sidebar initialized');

})();