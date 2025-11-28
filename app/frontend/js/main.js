// Lógica da página inicial (criação/entrada em salas)

function $(selector) {
  return document.querySelector(selector);
}

document.addEventListener('DOMContentLoaded', () => {
  const createForm = $('#create-room-form');
  const roomNameInput = $('#room-name');
  const privateCheckbox = $('#room-private');
  const accessCodeGroup = $('#access-code-group');
  const accessCodeInput = $('#room-access-code');
  const createError = $('#create-room-error');

  const joinForm = $('#join-room-form');
  const joinSlugInput = $('#join-slug');
  const joinError = $('#join-room-error');

  if (privateCheckbox) {
    privateCheckbox.addEventListener('change', () => {
      if (privateCheckbox.checked) {
        accessCodeGroup.classList.remove('hidden');
      } else {
        accessCodeGroup.classList.add('hidden');
        accessCodeInput.value = '';
      }
    });
  }

  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      createError.classList.add('hidden');
      createError.textContent = '';

      const name = roomNameInput.value.trim();
      const isPrivate = privateCheckbox.checked;
      const accessCode = accessCodeInput.value.trim();

      if (!name) {
        createError.textContent = 'Informe um nome para a sala.';
        createError.classList.remove('hidden');
        return;
      }

      if (isPrivate && !accessCode) {
        createError.textContent = 'Defina um código de acesso para salas privadas.';
        createError.classList.remove('hidden');
        return;
      }

      try {
        createForm.querySelector('button[type="submit"]').disabled = true;

        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name,
            private: isPrivate,
            accessCode: isPrivate ? accessCode : undefined
          })
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Não foi possível criar a sala.');
        }

        const data = await res.json();
        if (data.slug) {
          window.location.href = `/room/${data.slug}`;
        } else {
          throw new Error('Resposta inválida do servidor.');
        }
      } catch (err) {
        console.error(err);
        createError.textContent = err.message || 'Erro ao criar sala.';
        createError.classList.remove('hidden');
      } finally {
        createForm.querySelector('button[type="submit"]').disabled = false;
      }
    });
  }

  if (joinForm) {
    joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      joinError.classList.add('hidden');
      joinError.textContent = '';

      const slug = (joinSlugInput.value || '').trim();
      if (!slug) {
        joinError.textContent = 'Informe o ID (slug) da sala.';
        joinError.classList.remove('hidden');
        return;
      }

      window.location.href = `/room/${encodeURIComponent(slug)}`;
    });
  }
});


