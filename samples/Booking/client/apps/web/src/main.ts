import config from '~/app.config';
import { ReservationList } from './reservation-list';

const list = new ReservationList(config.apiUrl);
document.querySelector('#app')?.append(list.render());
void list.reload();
