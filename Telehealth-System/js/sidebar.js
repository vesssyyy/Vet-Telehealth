/**
 * Sidebar Layout Controller
 * Handles sidebar navigation, mobile menu, and active states
 */

(function() {
    'use strict';

    // Wait for DOM to be ready
    document.addEventListener('DOMContentLoaded', initSidebar);

    function initSidebar() {
        setupMobileMenu();
        setActiveNavItem();
        setupUserProfile();
    }

    /**
     * Mobile Menu Toggle
     */
    function setupMobileMenu() {
        const menuToggle = document.querySelector('.mobile-menu-toggle');
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');

        if (!menuToggle || !sidebar) return;

        // Toggle sidebar on mobile
        menuToggle.addEventListener('click', () => {
            sidebar.classList.toggle('active');
            menuToggle.classList.toggle('hidden');
            if (overlay) {
                overlay.classList.toggle('active');
            }
        });

        // Close sidebar when clicking overlay
        if (overlay) {
            overlay.addEventListener('click', () => {
                sidebar.classList.remove('active');
                menuToggle.classList.remove('hidden');
                overlay.classList.remove('active');
            });
        }

        // No need to close sidebar on nav click - browser reloads the page anyway
    }

    /**
     * Set Active Navigation Item based on current page
     */
    function setActiveNavItem() {
        const currentPage = window.location.pathname.split('/').pop();
        const navItems = document.querySelectorAll('.nav-item');

        navItems.forEach(item => {
            const href = item.getAttribute('href');
            if (href === currentPage) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    /**
     * Setup User Profile with initials
     * Will be populated with real data from Firebase later
     */
    function setupUserProfile() {
        const userName = document.querySelector('.user-name');
        const userAvatarInitials = document.getElementById('sidebar-avatar');
        const userAvatarImg = document.getElementById('sidebar-avatar-img');

        // If a profile photo is present and visible, don't overwrite initials.
        if (userAvatarImg && !userAvatarImg.classList.contains('is-hidden') && userAvatarImg.getAttribute('src')) {
            return;
        }

        if (userName && userAvatarInitials) {
            // Get initials of display name for avatar
            const initials = getInitials(userName.textContent);
            userAvatarInitials.textContent = initials;
        }
    }

    /**
     * Extract initials from name
     */
    function getInitials(name) {
        if (!name) return '?';
        
        const parts = name.trim().split(' ');
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name[0].toUpperCase();
    }

})();
