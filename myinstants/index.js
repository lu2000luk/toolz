const fs = require('fs');
const cheerio = require('cheerio');
var request = require('request');

var url = 'https://www.myinstants.com/en/search/'; 
const baseurl = "https://www.myinstants.com"

const timeoutInMilliseconds = 30*1000

var finalArray = []

var ottanta = new Array(50).fill(1)
var pagesDone = 0;
var fullPages = 0;

var stopQuery = {}

fs.readFile('cc.txt', 'utf8', (err, data) => {
    if (err) {
        console.error('Error reading file:', err);
        return;
    }

    console.log("cc loaded!")

    const wordsArray = data.trim().split('\n');

    wordsArray.forEach((searchItem, searchIndex) => {
        console.log("Loading query: "+searchItem)
        ottanta.forEach(async (_, index) => {
            
            try {
                setTimeout(async () => {
                    fullPages++
                    if (stopQuery[searchItem] === true) {return}

                    var opts = {
                        url: url+"?name="+searchItem+"&page="+index,
                        timeout: timeoutInMilliseconds,
                        
                    }
                
                    request(opts, async function (err, res, body) {

                    
                    if (err) {
                        console.dir(err);
                        stopQuery[searchItem] = true;
                        return;
                    }
                    var statusCode = res.statusCode;
                    var rawHtml = body;
                    $ = cheerio.load(body)
                
                    var respondeArray = [];
                
                    $('.instant').each(function(i, elem) {
                        
                        var title =  $(this).text();
                        var link = $(this).children('.small-button').attr('onclick');
                        var item = {
                            title : title,
                            link : link
                        };
                
                         respondeArray[i] = item;
                    });
                
                    respondeArray.forEach((i) => {
                        let link = i.link;
                        finalArray.push({url: baseurl+link.split("'")[1], title: i.title})
                    })
                    
                    console.clear()

                    console.log(fullPages + "/" +  (wordsArray.length*50) + " pages scraped! ["+((fullPages/(wordsArray.length*50))*100)+"%]");

                    console.log("Page "+index+" done for "+searchItem)
                    pagesDone++;
                    console.log("PagesDone "+pagesDone)
                    if (pagesDone >= (ottanta.length-1)) {pagesDone = 0; fs.writeFile("links.json", JSON.stringify(finalArray), (err) => {if (err) { console.log(err); } else {console.log("File written successfully\n");}})}
                })
            
                }, ((pagesDone+1) * 250 * (searchIndex+10)))
            } catch {
                console.log("Error with page: "+index+"/"+searchItem)
            }
        })
    })
});

