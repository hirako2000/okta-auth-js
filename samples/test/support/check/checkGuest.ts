import waitForDisplayed from '../wait/waitForDisplayed';

import Home from '../selectors/Home';

export default async () => {
  await waitForDisplayed(Home.registerButton, false);
  await waitForDisplayed(Home.loginButton, false);
};
