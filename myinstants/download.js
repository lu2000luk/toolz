const fs = require('fs');
const axios = require('axios');
const path = require('path');

const linksFilePath = 'links.json';
const outputFolder = 'files';

var downloaded = {}

const lastTime = 0;

// Create the output folder if it doesn't exist
if (!fs.existsSync(outputFolder)) {
  fs.mkdirSync(outputFolder);
}

// Read links from the JSON file
const links = JSON.parse(fs.readFileSync(linksFilePath));

// Function to download a file
async function downloadFile(url, destination) {
  if (downloaded[url]) {return} else {downloaded[url] = true}
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
  });

  response.data.pipe(fs.createWriteStream(destination));

  return new Promise((resolve, reject) => {
    response.data.on('end', () => {
      resolve();
    });

    response.data.on('error', (err) => {
      reject(err);
    });
  });
}

let totd = 0;

// Function to download all files
async function downloadAllFiles() {
  for (const link of links) {
    totd++
    const fileName = link.title.replace(/[\n*\/\\?$"#:<>|_]/g, '')+path.extname(path.basename(link.url));
    const destinationPath = path.join(outputFolder, fileName);

    try {
      if (totd < lastTime) {
        console.log(totd + " was skipped "+`(${totd}/${links.length}) [${Math.round((totd/links.length)*100)}%]`)
      } else {
        await downloadFile(link.url, destinationPath);
        console.log(`Downloaded: ${fileName} (${totd}/${links.length}) [${Math.round((totd/links.length)*100)}%]`);
      }
    } catch (error) {
      console.error(`Error downloading ${fileName}: ${error.message} (${totd}/${links.length}) [${Math.round((totd/links.length)*100)}%]`);
    }
  }
}

// Start downloading
downloadAllFiles();
