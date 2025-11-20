const bcrypt = require("bcryptjs");

bcrypt.hash("nlm-admin!", 10).then((hash) => {
  console.log("Hashed password:", hash);
});
