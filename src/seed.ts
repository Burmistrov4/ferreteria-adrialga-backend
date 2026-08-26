import { prisma } from './config/db';
import { hashPassword } from './utils/password.util';

async function main() {
  const hashedPassword = await hashPassword('admin123');

  const usuario = await prisma.usuarios.upsert({
    where: { Credencial: 'admin' },
    update: {
      Password: hashedPassword,
      Activo: true
    },
    create: {
      Credencial: 'admin',
      Nombre: 'Administrador del Sistema',
      Password: hashedPassword,
      Rol: 'ADMIN',
      Activo: true
    }
  });

  console.log('✅ Usuario Admin listo:', usuario.Credencial);
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());