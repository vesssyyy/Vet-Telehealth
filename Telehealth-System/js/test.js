function toggleForm() {
    const loginRadio = document.getElementById('login');
    const loginForm = document.getElementById('login-page');
    const registerForm = document.getElementById('register-page');

    if (loginRadio.checked) {
        loginForm.style.display = 'block';
        registerForm.style.display = 'none';
    } else {
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
    }
}

document.addEventListener('DOMContentLoaded', (event) => {
    toggleForm();
});
