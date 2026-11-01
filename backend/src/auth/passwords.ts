// Small dependency-free blocklist, case-insensitive, applied only by administrative password writes.
export const COMMON_PASSWORDS = new Set(`
123456 password 123456789 12345678 12345 1234567 qwerty abc123 password1 111111
123123 admin letmein welcome monkey dragon football iloveyou sunshine princess
login passw0rd master hello shadow baseball michael superman trustno1 hunter2
qwerty123 welcome1 admin123 changeme secret computer internet freedom whatever starwars
password123 password1234 password12345 password123456 password1234567 password12345678 password123456789
Password! password123! password1234! password12345! password123456! passwordpassword
qwertyuiop qwertyuiop123 qwertyuiop12345 qwertyuiopasdfgh asdfghjkl asdfghjkl12345
1234567890 12345678901 123456789012 1234567890123 12345678901234 123456789012345
111111111111 000000000000 222222222222 333333333333 444444444444 555555555555
666666666666 777777777777 888888888888 999999999999 abcdefghijkl abcdefghijklmnop
administrator administrator1 administrator123 adminadminadmin welcome12345 welcome123456
letmeinletmein letmein123456 iloveyou12345 iloveyou123456 changeme12345 changeme123456
correcthorsebatterystaple correct horse battery staple trustno1trustno1 defaultpassword
openduetpassword claude123456 password!password! testing123456 testtesttesttest
football12345 football123456 sunshine12345 princess12345 monkeymonkey dragon123456
superman12345 superman123456 computer12345 internet12345 welcomehome123
`.toLowerCase().split(/\s+/).filter(Boolean));
export const isCommonPassword = (value: string) => COMMON_PASSWORDS.has(value.trim().toLowerCase()) || value.trim().toLowerCase() === "correct horse battery staple";
