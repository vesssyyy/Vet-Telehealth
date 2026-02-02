  function toggleMenu() {
    const menu = document.getElementById("menuDropdown");
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  }

  window.onclick = function(event) {
    if (!event.target.closest('.dropdown')) {
      const menu = document.getElementById("menuDropdown");
      if (menu) menu.style.display = "none";
    }
  }

const button = document.querySelector('#menu');

button.addEventListener('click', function() {
  button.classList.toggle('is-clicked');
});
