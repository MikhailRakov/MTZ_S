import { getInitials } from './get_initials.js';

export function updateProfileUI(user,userAvatarSmall,userAvatarLarge,profileName,profileEmail,profileDropdown) {
    if (user) {
        let currentUser = user;
        const initials = getInitials(user.displayName);
        const photoURL = user.photoURL;
        // Обновляем маленький аватар в header
        if (photoURL) {
            userAvatarSmall.innerHTML = `<img src="${photoURL}" alt="Avatar">`;
        } else {
            userAvatarSmall.textContent = initials;
        }
        // Обновляем большой аватар в dropdown
        if (photoURL) {
            userAvatarLarge.innerHTML = `<img src="${photoURL}" alt="Avatar">`;
        } else {
            userAvatarLarge.textContent = initials;
        }
        // Обновляем имя и email
        profileName.textContent = user.displayName || 'Без имени';
        profileEmail.textContent = user.email || 'Нет email';
        return currentUser
    } else {
        // Сбрасываем UI, если пользователь вышел
        let currentUser = null;
        userAvatarSmall.textContent = '?';
        userAvatarLarge.textContent = '?';
        profileName.textContent = 'Загрузка...';
        profileEmail.textContent = 'Загрузка...';
        profileDropdown.classList.remove('show');
        return currentUser
    }
    
}