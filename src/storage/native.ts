import { openDatabaseAsync } from 'expo-sqlite';
import { LocalRepository } from './repository';
export async function openRepository() {
  const repository = new LocalRepository(await openDatabaseAsync('meeshogi.db'));
  await repository.initialize();
  return repository;
}
